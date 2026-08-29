// unattached comment
declare function trace(): (
  value: (this: Service, id: string) => Promise<string>,
  context: ClassMethodDecoratorContext<Service, (this: Service, id: string) => Promise<string>>,
) => void;
export const prefix = '日本語 🦊';

export class Service {
  /** Fetches one user. */
  @trace()
  public async fetch(id: string): Promise<string> { return id; }
}

export const value = 1;
export const typed: { readonly label: string } = { label: 'raw' };
export const genericTyped: <T = string>(value: T) => T = <T>(value: T): T => value;
