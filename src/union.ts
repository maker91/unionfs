import { FSWatcher, Dirent, ReadStream, WriteStream } from 'fs';
import { IFS } from './fs';
import {
  fsSyncMethodsWrite,
  fsSyncMethodsRead,
  fsAsyncMethodsWrite,
  fsAsyncMethodsRead,
  fsPromiseMethodsWrite,
  fsPromiseMethodsRead,
} from './lists';

export interface IUnionFsError extends Error {
  prev?: IUnionFsError | null;
}

type readdirEntry = string | Buffer | Dirent;

const SPECIAL_METHODS = new Set([
  'existsSync',
  'readdir',
  'readdirSync',
  'createReadStream',
  'createWriteStream',
  'watch',
  'watchFile',
  'unwatchFile',
  'open',
  'openSync',
]);

const createFSProxy = (watchers: FSWatcher[]) =>
  new Proxy(
    {},
    {
      get(_obj, property) {
        const funcCallers: Array<[FSWatcher, Function]> = [];
        let prop: Function | undefined;
        for (const watcher of watchers) {
          prop = watcher[property];
          // if we're a function we wrap it in a bigger caller;
          if (typeof prop === 'function') {
            funcCallers.push([watcher, prop]);
          }
        }

        if (funcCallers.length) {
          return (...args) => {
            for (const [watcher, func] of funcCallers) {
              func.apply(watcher, args);
            }
          };
        } else {
          return prop;
        }
      },
    },
  );

export type VolOptions = {
  readable?: boolean;
  writable?: boolean;
};


type Constructor<T> = new (...args: any[]) => T;

function stripBoundVolumeArg<T extends Constructor<ReadStream> | Constructor<WriteStream>>(stream: T): T {
  return class extends stream {
    constructor(...args) {
      if (args.length && !(args[0] instanceof Buffer || typeof args[0] === 'string')) {
        args.shift();
      }

      super(...args);
    }
  }
}


/**
 * Union object represents a stack of filesystems
 */
export class Union {
  private fss: [IFS, VolOptions][] = [];

  public ReadStream: typeof ReadStream | (new (...args: any[]) => ReadStream) = stripBoundVolumeArg(ReadStream);
  public WriteStream: typeof WriteStream | (new (...args: any[]) => WriteStream) = stripBoundVolumeArg(WriteStream);

  private promises: {} = {};

  constructor() {
    for (let method of [...fsSyncMethodsRead, ...fsSyncMethodsWrite]) {
      if (!SPECIAL_METHODS.has(method)) {
        // check we don't already have a property for this method
        this[method] = (...args) => this.syncMethod(method, args);
      }
    }
    for (let method of [...fsAsyncMethodsRead, ...fsAsyncMethodsWrite]) {
      if (!SPECIAL_METHODS.has(method)) {
        // check we don't already have a property for this method
        this[method] = (...args) => this.asyncMethod(method, args);
      }
    }

    for (let method of [...fsPromiseMethodsRead, ...fsPromiseMethodsWrite]) {
      if (method === 'readdir') {
        this.promises[method] = this.readdirPromise;

        continue;
      }

      this.promises[method] = (...args) => this.promiseMethod(method, args);
    }

    for (let method of SPECIAL_METHODS.values()) {
      // bind special methods to support
      this[method] = this[method].bind(this);
    }
  }

  public open = (...args) => {
    let flags;

    if (args.length < 3) {
      flags = 'r';
    } else {
      flags = args[1];
    }

    let lastarg = args.length - 1;
    let cb = args[lastarg];
    if (typeof cb !== 'function') {
      cb = null;
      lastarg++;
    }

    let lastError: IUnionFsError | null = null;
    const iterate = (i = 0, err?: IUnionFsError) => {
      if (err) {
        err.prev = lastError;
        lastError = err;
      }

      // Already tried all file systems, return the last error.
      if (i >= this.fss.length) {
        // last one
        if (cb) cb(err ?? (!this.fss.length ? new Error('No file systems attached.') : undefined));
        return;
      }

      const j = this.fss.length - i - 1;
      const [fs, { readable, writable }] = this.fss[j];
      const func = fs.open;

      if (flags.startsWith('r') && readable === false) return iterate(i + 1);
      if (flags.startsWith('w') && writable === false) return iterate(i + 1);
      if (flags.startsWith('a') && (writable === false || readable === false)) return iterate(i + 1);

      // Replace `callback` with our intermediate function.
      args[lastarg] = function (err) {
        if (err) return iterate(i + 1, err);
        if (cb) cb.apply(cb, arguments);
      };

      if (!func) iterate(i + 1, Error('Method not supported: open'));
      else {
        try {
          func.apply(fs, args);
        } catch (err) {
          iterate(i + 1, err);
        }
      }
    };
    iterate();
  };

  public openSync = (...args) => {
    const flags = args[1];

    let lastError: IUnionFsError | null = null;
    for (let i = this.fss.length - 1; i >= 0; i--) {
      const [fs, { readable, writable }] = this.fss[i];
      if (flags.startsWith('r') && readable === false) continue;
      if (flags.startsWith('w') && writable === false) continue;
      if (flags.startsWith('a') && (writable === false || readable === false)) continue;
      try {
        if (!fs.openSync) throw Error(`Method not supported: "openSync" with args "${args}"`);
        return fs.openSync.apply(fs, args);
      } catch (err) {
        err.prev = lastError;
        lastError = err;
        if (!i) {
          // last one
          throw err;
        } else {
          // Ignore error...
          // continue;
        }
      }
    }
  };

  public unwatchFile = (...args) => {
    throw new Error('unwatchFile is not supported, please use watchFile');
  };

  public watch = (...args) => {
    const watchers: FSWatcher[] = [];
    for (const [fs, { readable }] of this.fss) {
      if (readable === false) continue;
      try {
        const watcher = fs.watch.apply(fs, args);
        watchers.push(watcher);
      } catch (e) {
        // dunno what to do here...
      }
    }

    // return a proxy to call functions on these props
    return createFSProxy(watchers);
  };

  public watchFile = (...args) => {
    for (const [fs, { readable }] of this.fss) {
      if (readable === false) continue;
      try {
        fs.watchFile.apply(fs, args);
      } catch (e) {
        // dunno what to do here...
      }
    }
  };

  public existsSync = (path: string) => {
    for (const [fs, { readable }] of this.fss) {
      if (readable === false) continue;
      try {
        if (fs.existsSync(path)) {
          return true;
        }
      } catch (e) {
        // ignore
      }
    }

    return false;
  };

  public readdir = (...args): void => {
    let lastarg = args.length - 1;
    let cb = args[lastarg];
    if (typeof cb !== 'function') {
      cb = null;
      lastarg++;
    }

    let lastError: IUnionFsError | null = null;
    let result = new Map<string, readdirEntry>();
    const iterate = (i = 0, error?: IUnionFsError | null) => {
      if (error) {
        error.prev = lastError;
        lastError = error;
      }

      // Already tried all file systems, return the last error.
      if (i >= this.fss.length) {
        // last one
        if (cb) {
          cb(error || Error('No file systems attached.'));
        }
        return;
      }

      // Replace `callback` with our intermediate function.
      args[lastarg] = (err, resArg: readdirEntry[]) => {
        if (result.size === 0 && err) {
          return iterate(i + 1, err);
        }
        if (resArg) {
          for (const res of resArg) {
            result.set(this.pathFromReaddirEntry(res), res);
          }
        }

        if (i === this.fss.length - 1) {
          return cb(null, this.sortedArrayFromReaddirResult(result));
        } else {
          return iterate(i + 1, error);
        }
      };

      const j = this.fss.length - i - 1;
      const [fs, { readable }] = this.fss[j];
      const func = fs.readdir;

      if (!func) iterate(i + 1, Error('Method not supported: readdir'));
      else if (readable === false) iterate(i + 1, Error(`Readable disabled for vol '${i}': readdir`));
      else func.apply(fs, args);
    };
    iterate();
  };

  public readdirSync = (...args): Array<readdirEntry> => {
    let lastError: IUnionFsError | null = null;
    let result = new Map<string, readdirEntry>();
    for (let i = this.fss.length - 1; i >= 0; i--) {
      const [fs, { readable }] = this.fss[i];
      if (readable === false) continue;
      try {
        if (!fs.readdirSync) throw Error(`Method not supported: "readdirSync" with args "${args}"`);
        for (const res of fs.readdirSync.apply(fs, args)) {
          result.set(this.pathFromReaddirEntry(res), res);
        }
      } catch (err) {
        err.prev = lastError;
        lastError = err;
        if (result.size === 0 && !i) {
          // last one
          throw err;
        } else {
          // Ignore error...
          // continue;
        }
      }
    }
    return this.sortedArrayFromReaddirResult(result);
  };

  public readdirPromise = async (...args): Promise<Array<readdirEntry>> => {
    let lastError: IUnionFsError | null = null;
    let result = new Map<string, readdirEntry>();
    for (let i = this.fss.length - 1; i >= 0; i--) {
      const [fs, { readable }] = this.fss[i];
      if (readable === false) continue;
      try {
        if (!fs.promises || !fs.promises.readdir)
          throw Error(`Method not supported: "readdirSync" with args "${args}"`);
        for (const res of await fs.promises.readdir.apply(fs, args)) {
          result.set(this.pathFromReaddirEntry(res), res);
        }
      } catch (err) {
        err.prev = lastError;
        lastError = err;
        if (result.size === 0 && !i) {
          // last one
          throw err;
        } else {
          // Ignore error...
          // continue;
        }
      }
    }
    return this.sortedArrayFromReaddirResult(result);
  };

  private pathFromReaddirEntry = (readdirEntry: readdirEntry): string => {
    if (readdirEntry instanceof Buffer || typeof readdirEntry === 'string') {
      return String(readdirEntry);
    }
    return readdirEntry.name;
  };

  private sortedArrayFromReaddirResult = (readdirResult: Map<string, readdirEntry>): readdirEntry[] => {
    const array: readdirEntry[] = [];
    for (const key of Array.from(readdirResult.keys()).sort()) {
      const value = readdirResult.get(key);
      if (value !== undefined) array.push(value);
    }
    return array;
  };

  public createReadStream = (path: string) => {
    let lastError = null;
    for (const [fs, { readable }] of this.fss) {
      if (readable === false) continue;
      try {
        if (!fs.createReadStream) throw Error(`Method not supported: "createReadStream"`);

        if (fs.existsSync && !fs.existsSync(path)) {
          throw new Error(`file "${path}" does not exists`);
        }

        const stream = fs.createReadStream(path);
        if (!stream) {
          throw new Error('no valid stream');
        }
        this.ReadStream = fs.ReadStream;

        return stream;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError;
  };

  public createWriteStream = (path: string, options?: any) => {
    options = options || {};
    let lastError = null;
    for (const [fs, { writable }] of this.fss) {
      if (writable === false) continue;
      try {
        if (!fs.createWriteStream) throw Error(`Method not supported: "createWriteStream"`);

        options.fs = fs;
        const stream = fs.createWriteStream(path, options);
        if (!stream) {
          throw new Error('no valid stream');
        }
        this.WriteStream = fs.WriteStream;

        return stream;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError;
  };

  /**
   * Adds a filesystem to the list of filesystems in the union
   * The new filesystem object is added as the last filesystem used
   * when searching for a file.
   *
   * @param fs the filesystem interface to be added to the queue of FS's
   * @returns this instance of a unionFS
   */
  use(fs: IFS, options: VolOptions = {}): this {
    this.fss.push([this.createFS(fs, options), options]);
    return this;
  }

  /**
   * At the time of the [[use]] call, we create our sync, async and promise methods
   * for performance reasons
   *
   * @param fs
   * @param options
   */
  private createFS(fs: IFS, { readable = true, writable = true }: VolOptions): IFS {
    const createErroringFn = (state: 'readable' | 'writable') => (...args: any[]) => {
      throw new Error(`Filesystem is not ${state}`);
    };
    const createFunc = (method: string): any => {
      if (!fs[method])
        return (...args: any[]) => {
          throw new Error(`Method not supported: "${method}" with args "${args}"`);
        };
      return (...args: any[]) => fs[method as string](...args);
    };

    return {
      ...fs,
      ...fsSyncMethodsRead.reduce((acc, method) => {
        acc[method] = readable ? createFunc(method) : createErroringFn('readable');
        return acc;
      }, {}),
      ...fsSyncMethodsWrite.reduce((acc, method) => {
        acc[method] = writable ? createFunc(method) : createErroringFn('writable');
        return acc;
      }, {}),
      ...fsAsyncMethodsRead.reduce((acc, method) => {
        acc[method] = readable ? createFunc(method) : createErroringFn('readable');
        return acc;
      }, {}),
      ...fsAsyncMethodsWrite.reduce((acc, method) => {
        acc[method] = writable ? createFunc(method) : createErroringFn('writable');
        return acc;
      }, {}),
      promises: {
        ...fs.promises,
        ...fsPromiseMethodsRead.reduce((acc, method) => {
          const promises = fs.promises;
          if (!promises || !promises[method]) {
            acc[method] = (...args: any) => {
              throw Error(`Promise of method not supported: "${String(method)}" with args "${args}"`);
            };
            return acc;
          }
          acc[method] = readable ? (...args: any) => promises[method as string].apply(fs, args) : createErroringFn('readable');
          return acc;
        }, {}),
        ...fsPromiseMethodsWrite.reduce((acc, method) => {
          const promises = fs.promises;
          if (!promises || !promises[method]) {
            acc[method] = (...args: any) => {
              throw Error(`Promise of method not supported: "${String(method)}" with args "${args}"`);
            };
            return acc;
          }
          acc[method] = writable ? (...args: any) => promises[method as string].apply(fs, args) : createErroringFn('writable');
          return acc;
        }, {}),
      },
    };
  }

  private syncMethod(method: string, args: any[]) {
    if (!this.fss.length) throw new Error('No file systems attached');
    let lastError: IUnionFsError | null = null;
    for (let i = this.fss.length - 1; i >= 0; i--) {
      const [fs] = this.fss[i];
      try {
        if (!fs[method]) throw Error(`Method not supported: "${method}" with args "${args}"`);
        return fs[method](...args);
      } catch (err) {
        err.prev = lastError;
        lastError = err;
        if (!i) {
          // last one
          throw err;
        } else {
          // Ignore error...
          // continue;
        }
      }
    }
  }

  private asyncMethod(method: string, args: any[]) {
    let lastarg = args.length - 1;
    let cb = args[lastarg];
    if (typeof cb !== 'function') {
      cb = null;
      lastarg++;
    }

    let lastError: IUnionFsError | null = null;
    const iterate = (i = 0, err?: IUnionFsError) => {
      if (err) {
        err.prev = lastError;
        lastError = err;
      }

      // Already tried all file systems, return the last error.
      if (i >= this.fss.length) {
        // last one
        if (cb) cb(err ?? (!this.fss.length ? new Error('No file systems attached.') : undefined));
        return;
      }

      // Replace `callback` with our intermediate function.
      args[lastarg] = function (err) {
        if (err) return iterate(i + 1, err);
        if (cb) cb.apply(cb, arguments);
      };

      const j = this.fss.length - i - 1;
      const [fs] = this.fss[j];
      const func = fs[method];

      if (!func) iterate(i + 1, Error('Method not supported: ' + method));
      else {
        try {
          func(...args);
        } catch (err) {
          iterate(i + 1, err);
        }
      }
    };
    iterate();
  }

  async promiseMethod(method: string, args: any[]) {
    let lastError = null;

    for (let i = this.fss.length - 1; i >= 0; i--) {
      const [theFs] = this.fss[i];

      const promises = theFs.promises;

      try {
        if (!promises || !promises[method]) {
          throw Error(`Promise of method not supported: "${String(method)}" with args "${args}"`);
        }

        return await promises[method].apply(promises, args);
      } catch (err) {
        err.prev = lastError;
        lastError = err;
        if (!i) {
          // last one
          throw err;
        } else {
          // Ignore error...
          // continue;
        }
      }
    }
  }
}
