import { Mutex } from 'async-mutex';

export interface ProjectWriteCoordinatorOptions {
  lockTimeoutMs?: number;
}

export class ProjectWriteCoordinator {
  private readonly mutex = new Mutex();

  constructor(private readonly options: ProjectWriteCoordinatorOptions = {}) {}

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
