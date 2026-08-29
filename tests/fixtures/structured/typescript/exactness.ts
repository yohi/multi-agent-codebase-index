// unattached comment
declare function trace(): ClassDecorator;

/** Fetches one user. */
@trace()
export class Service {
  public async fetch(id: string): Promise<string> { return id; }
}

export const value = 1;
