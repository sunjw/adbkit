import Bluebird from 'bluebird';
import Protocol from './protocol';
import { Duplex } from 'stream';

class FailError extends Error {
  constructor(message: string) {
    super(`Failure: '${message}'`);
    Object.setPrototypeOf(this, FailError.prototype);
    this.name = 'FailError';
    Error.captureStackTrace(this, FailError);
  }
}

class PrematureEOFError extends Error {
  public missingBytes: number;
  constructor(howManyMissing: number) {
    super(`Premature end of stream, needed ${howManyMissing} more bytes`);
    Object.setPrototypeOf(this, PrematureEOFError.prototype);
    this.name = 'PrematureEOFError';
    this.missingBytes = howManyMissing;
    Error.captureStackTrace(this, PrematureEOFError);
  }
}

class UnexpectedDataError extends Error {
  constructor(public unexpected: string, public expected: string) {
    super(`Unexpected '${unexpected}', was expecting ${expected}`);
    Object.setPrototypeOf(this, UnexpectedDataError.prototype);
    this.name = 'UnexpectedDataError';
    Error.captureStackTrace(this, UnexpectedDataError);
  }
}

class TimeoutError extends Error {
  constructor() {
    super(`Socket timeout reached.`);
    Object.setPrototypeOf(this, TimeoutError.prototype);
    this.name = 'TimeoutError';
    Error.captureStackTrace(this, TimeoutError);
  }
}

Bluebird.config({
  // Enable warnings
  // warnings: true,
  // Enable long stack traces
  // longStackTraces: true,
  // Enable cancellation
  cancellation: true,
  // Enable monitoring
  // monitoring: true,
});

export default class Parser {
  public static FailError = FailError;
  public static PrematureEOFError = PrematureEOFError;
  public static UnexpectedDataError = UnexpectedDataError;
  public static TimeoutError = TimeoutError;
  private ended = false;

  constructor(public stream: Duplex) {
    // empty
  }

  public end(): Bluebird<boolean> {
    if (this.ended) {
      return Bluebird.resolve<boolean>(true);
    }
    let tryRead: () => void;
    let errorListener: (error: Error) => void;
    let endListener: () => void;
    let timeoutListener: () => void;
    return new Bluebird<boolean>((resolve, reject, onCancel) => {
      tryRead = () => {
        while (this.stream.read()) {
          // ignore
        }
      };
      errorListener = function (err) {
        return reject(err);
      };
      endListener = () => {
        this.ended = true;
        return resolve(true);
      };
      timeoutListener = () => {
        this.stream.end()
        return reject(new Parser.TimeoutError());
      };
      this.stream.on('readable', tryRead);
      this.stream.on('error', errorListener);
      this.stream.on('end', endListener);
      this.stream.on('timeout', timeoutListener);
      this.stream.read(0);
      this.stream.end();
      onCancel(() => {
        // console.log('1-onCanceled');
      });
    }).finally(() => {
      this.stream.removeListener('readable', tryRead);
      this.stream.removeListener('error', errorListener);
      this.stream.removeListener('end', endListener);
      this.stream.removeListener('timeout', timeoutListener);
      // return r;
    });
  }

  public raw(): Duplex {
    return this.stream;
  }

  public readAll(): Bluebird<Buffer> {
    let all = Buffer.alloc(0);

    let tryRead: () => void;
    let errorListener: (error: Error) => void;
    let endListener: () => void;
    let timeoutListener: () => void;

    return new Bluebird<Buffer>((resolve, reject, onCancel) => {
      tryRead = () => {
        let chunk;
        while ((chunk = this.stream.read())) {
          all = Buffer.concat([all, chunk]);
        }
        if (this.ended) {
          return resolve(all);
        }
      };
      errorListener = function (err) {
        return reject(err);
      };
      endListener = () => {
        this.ended = true;
        return resolve(all);
      };
      timeoutListener = () => {
        this.stream.end()
        return reject(new Parser.TimeoutError());
      };
      this.stream.on('readable', tryRead);
      this.stream.on('error', errorListener);
      this.stream.on('end', endListener);
      this.stream.on('timeout', timeoutListener);
      tryRead();
      onCancel(() => {
        // console.log('2-onCanceled');
      });
    }).finally(() => {
      this.stream.removeListener('readable', tryRead);
      this.stream.removeListener('error', errorListener);
      this.stream.removeListener('end', endListener);
      this.stream.removeListener('timeout', timeoutListener);
    });
  }

  public readAscii(howMany: number): Bluebird<string> {
    return this.readBytes(howMany).then((chunk) => chunk.toString('ascii'));
  }

  public readBytes(howMany: number): Bluebird<Buffer> {
    let tryRead: () => void;
    let errorListener: (error: Error) => void;
    let endListener: () => void;
    let timeoutListener: () => void;
    return new Bluebird<Buffer>((resolve, reject /*, onCancel*/) => {
      tryRead = () => {
        if (howMany) {
          const chunk = this.stream.read(howMany);
          if (chunk) {
            // If the stream ends while still having unread bytes, the read call
            // will ignore the limit and just return what it's got.
            howMany -= chunk.length;
            if (howMany === 0) {
              return resolve(chunk);
            }
          }
          if (this.ended) {
            return reject(new Parser.PrematureEOFError(howMany));
          }
        } else {
          return resolve(Buffer.alloc(0));
        }
      };
      endListener = () => {
        this.ended = true;
        return reject(new Parser.PrematureEOFError(howMany));
      };
      timeoutListener = () => {
        this.stream.end()
        return reject(new Parser.TimeoutError());
      };
      errorListener = (err) => reject(err);
      this.stream.on('readable', tryRead);
      this.stream.on('error', errorListener);
      this.stream.on('end', endListener);
      this.stream.on('timeout', timeoutListener);
      tryRead();
      // onCancel(() => {});
    }).finally(() => {
      this.stream.removeListener('readable', tryRead);
      this.stream.removeListener('error', errorListener);
      this.stream.removeListener('end', endListener);
      this.stream.removeListener('timeout', timeoutListener);
    });
  }

  public readByteFlow(howMany: number, targetStream: Duplex): Bluebird<void> {
    let tryRead: () => void;
    let errorListener: (error: Error) => void;
    let endListener: () => void;
    let timeoutListener: () => void;
    return new Bluebird<void>((resolve, reject /*, onCancel*/) => {
      tryRead = () => {
        if (howMany) {
          // Try to get the exact amount we need first. If unsuccessful, take
          // whatever is available, which will be less than the needed amount.
          // avoid chunk is undefined.
          let chunk;
          while (chunk = this.stream.read(howMany) || this.stream.read()) {
            howMany -= chunk.length;
            targetStream.write(chunk);
            if (howMany === 0) {
              return resolve();
            }
          }
          if (this.ended) {
            return reject(new Parser.PrematureEOFError(howMany));
          }
        } else {
          return resolve();
        }
      };
      endListener = () => {
        this.ended = true;
        return reject(new Parser.PrematureEOFError(howMany));
      };
      errorListener = function (err) {
        return reject(err);
      };
      timeoutListener = () => {
        this.stream.end()
        return reject(new Parser.TimeoutError());
      };
      this.stream.on('readable', tryRead);
      this.stream.on('error', errorListener);
      this.stream.on('end', endListener);
      this.stream.on('timeout', timeoutListener);
      tryRead();
      // onCancel(() => {});
    }).finally(() => {
      this.stream.removeListener('readable', tryRead);
      this.stream.removeListener('error', errorListener);
      this.stream.removeListener('end', endListener);
      this.stream.removeListener('timeout', timeoutListener);
    });
  }

  public readError(): Bluebird<never> {
    return this.readValue().then(function (value) {
      throw new Parser.FailError(value.toString());
    });
  }

  public readValue(): Bluebird<Buffer> {
    return this.readAscii(4).then((value) => {
      const length = Protocol.decodeLength(value);
      return this.readBytes(length);
    });
  }

  public readUntil(code: number): Bluebird<Buffer> {
    let skipped = Buffer.alloc(0);
    const read = () => {
      return this.readBytes(1).then(function (chunk) {
        if (chunk[0] === code) {
          return skipped;
        } else {
          skipped = Buffer.concat([skipped, chunk]);
          return read();
        }
      });
    };
    return read();
  }

  searchLine(re: RegExp): Bluebird<RegExpExecArray> {
    return this.readLine().then((line) => {
      const match = re.exec(line.toString());
      if (match) {
        return match;
      } else {
        return this.searchLine(re);
      }
    });
  }

  public readLine(): Bluebird<Buffer> {
    return this.readUntil(0x0a).then(function (line) {
      // '\n'
      if (line[line.length - 1] === 0x0d) {
        // '\r'
        return line.slice(0, -1);
      } else {
        return line;
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public unexpected(data: string, expected: string): Bluebird<any> {
    return Bluebird.reject(new Parser.UnexpectedDataError(data, expected));
  }
}
