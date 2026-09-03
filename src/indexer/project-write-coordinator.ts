import { Mutex, type MutexInterface, withTimeout } from 'async-mutex';

export interface ProjectWriteCoordinatorOptions {
  lockTimeoutMs?: number;
}

export class ProjectWriteCoordinator {
  private readonly mutex: MutexInterface;

  constructor(options: ProjectWriteCoordinatorOptions = {}) {
    const mutex = new Mutex();
    this.mutex = options.lockTimeoutMs === undefined
      ? mutex
      : withTimeout(mutex, options.lockTimeoutMs);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  isLocked(): Promise<boolean> {
    return Promise.resolve(this.mutex.isLocked());
  }
}
