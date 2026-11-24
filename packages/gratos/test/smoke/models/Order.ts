import type { Int } from "@dblechoc/gratos";

import { User } from "./User.ts";

/** @gqlType */
export class Order {
  /** @gqlField */
  id: string;
  /** @gqlField */
  quantity: Int;
  /** @gqlField */
  customer: User;

  constructor(id: string, quantity: Int, customer: User) {
    this.id = id;
    this.quantity = quantity;
    this.customer = customer;
  }
}

/** @gqlQueryField */
export async function orders(): Promise<Array<Order>> {
  const ada = new User("u1", "Ada", new Date("2026-01-02T03:04:05.000Z"));
  return [new Order("o1", 2, ada)];
}
