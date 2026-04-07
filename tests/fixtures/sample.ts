import { readFile, writeFile } from 'node:fs/promises';
import type { Config } from './config';
import * as path from 'node:path';
import defaultExport from './default-mod';
import def, { named as aliased, type TypeImport } from './mixed';

/** Maximum retry count */
export const MAX_RETRIES = 3;

let counter = 0;

/**
 * Greets a person by name.
 * @param name The person's name
 */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

/** A user in the system */
export interface User {
  id: string;
  name: string;
  email: string;
}

export type Result<T> = { ok: T } | { err: string };

export enum Status {
  Active = 'active',
  Inactive = 'inactive',
}

export default class UserService {
  private db: Database;

  /** Creates a new service instance */
  static create(): UserService {
    return new UserService();
  }

  /** Find a user by ID */
  async findUser(id: string): Promise<User | null> {
    return this.db.find(id);
  }
}

/** Custom hook for authentication */
export function useAuth() {
  return { user: null };
}

export const fetchData = async (url: string): Promise<Response> => {
  return fetch(url);
};

const INTERNAL_CONSTANT = 42;

export { greet as hello } from './re-export';
export * from './star-export';
export type { Config as AppConfig } from './types';
