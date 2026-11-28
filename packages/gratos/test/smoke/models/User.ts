import type { ID } from "gratos";

import type { DateTime } from "./DateTime.ts";

/** @gqlType */
export class User {
  /** @gqlField */
  id: ID;
  /** @gqlField */
  name: string;
  /** @gqlField */
  joinedAt: DateTime;

  constructor(id: ID, name: string, joinedAt: DateTime) {
    this.id = id;
    this.name = name;
    this.joinedAt = joinedAt;
  }
}
