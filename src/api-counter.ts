export class ApiCounter {
  private count = 0;
  private limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  increment(): void {
    this.count++;
  }

  get current(): number {
    return this.count;
  }

  hasCapacity(needed: number = 1): boolean {
    return this.count + needed <= this.limit;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.count);
  }
}
