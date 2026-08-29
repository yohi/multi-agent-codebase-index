export class ValidClass {
  valid(): string { return 'ok'; }
}

export class BrokenClass {
  broken(): string { return ('missing'; }
}
