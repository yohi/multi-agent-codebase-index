import * as dependency from './dependency.js';

namespace Outer {
  export class Inner {
    constructor(public value: string) {}
    get label(): string { return this.value; }
    set label(value: string) { this.value = value; }
    property = 'x';
  }
}

type Alias = string;
enum State { Ready, Done }
const single = 1;
export const constant = dependency.value;
function overloaded(value: string): string;
function overloaded(value: number): string;
function overloaded(value: string | number): string { return String(value); }
export default class DefaultClass {}
const arrow = () => 'arrow';
const expression = function () { return 'expression'; };
const { destructured } = { destructured: 'x' };
const first = 1, second = 2;
export const 日本語 = '絵文字 🦊';
