import * as fs from 'fs';
import type { JsonlRecord } from './types.js';
import { validateRecord } from './jsonlValidator.js';

/** Maximum line buffer size (1MB). Lines exceeding this are discarded. */
const MAX_LINE_BUFFER = 1024 * 1024;
/** Maximum bytes to read per poll cycle (16MB). Prevents OOM from large JSONL appends. */
const MAX_READ_PER_CYCLE = 16 * 1024 * 1024;

/**
 * Byte-offset JSONL file tailer.
 * Reads new lines appended since the last read, buffers incomplete lines.
 * Uses Buffer-based lineBuffer to handle UTF-8 multibyte characters
 * split across read boundaries.
 *
 * All I/O is async (fs.promises) to avoid blocking the extension host thread.
 */
export class JsonlTailer {
  private offset = 0;
  private lineBuffer: Buffer = Buffer.alloc(0);

  constructor(private readonly filePath: string) {}

  /** Whether the last readNewRecords() detected a file truncation */
  truncated = false;

  /** mtime from the last successful stat (ms since epoch). 0 if never read. */
  lastMtimeMs = 0;

  /** Read all new complete lines since last call. Returns parsed records. */
  async readNewRecords(): Promise<JsonlRecord[]> {
    const records: JsonlRecord[] = [];
    this.truncated = false;

    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(this.filePath, 'r');
    } catch {
      return records;
    }

    try {
      const stat = await fh.stat();
      this.lastMtimeMs = stat.mtimeMs;

      // File shrank (truncation or rotation) — reset to beginning
      if (stat.size < this.offset) {
        this.offset = 0;
        this.lineBuffer = Buffer.alloc(0);
        this.truncated = true;
      }

      if (stat.size <= this.offset) {
        return records;
      }

      const bytesToRead = Math.min(stat.size - this.offset, MAX_READ_PER_CYCLE);
      const readBuf = Buffer.alloc(bytesToRead);
      const { bytesRead: actualRead } = await fh.read(readBuf, 0, bytesToRead, this.offset);
      // Use actual bytes read (not expected) to avoid offset drift on short reads [C5]
      this.offset += actualRead;

      const readSlice = actualRead < bytesToRead ? readBuf.subarray(0, actualRead) : readBuf;

      // Guard against transient memory spike from concat [H6]
      if (this.lineBuffer.length + readSlice.length > MAX_LINE_BUFFER) {
        this.lineBuffer = Buffer.alloc(0);
      }

      // Concatenate with any leftover bytes from previous read
      const combined = this.lineBuffer.length > 0
        ? Buffer.concat([this.lineBuffer, readSlice])
        : readSlice;

      // Find complete lines (terminated by \n = 0x0A)
      let lineStart = 0;
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] === 0x0A) {
          const lineBytes = combined.subarray(lineStart, i);
          lineStart = i + 1;

          const trimmed = lineBytes.toString('utf8').trim();
          if (!trimmed) { continue; }
          try {
            const record = validateRecord(JSON.parse(trimmed));
            if (record) { records.push(record); }
          } catch {
            // Skip malformed lines
          }
        }
      }

      // Buffer remaining incomplete line
      if (lineStart < combined.length) {
        this.lineBuffer = Buffer.from(combined.subarray(lineStart));
        // Cap line buffer to prevent unbounded growth
        if (this.lineBuffer.length > MAX_LINE_BUFFER) {
          this.lineBuffer = Buffer.alloc(0);
        }
      } else {
        this.lineBuffer = Buffer.alloc(0);
      }
    } finally {
      await fh.close();
    }

    return records;
  }

  /** Reset to re-read from the beginning */
  reset(): void {
    this.offset = 0;
    this.lineBuffer = Buffer.alloc(0);
  }

  /** Get current byte offset */
  getOffset(): number {
    return this.offset;
  }

  /** Get the file path being tailed */
  getFilePath(): string {
    return this.filePath;
  }
}
