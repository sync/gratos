// Plain AsyncIterable keeps upstream's behaviour outside Subscription: it is a list.

/** @gqlType */
export class User {
  /** @gqlField */
  async *greetings(): AsyncIterable<string> {
    yield "hi";
  }
}
