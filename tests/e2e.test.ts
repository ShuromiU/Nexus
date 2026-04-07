import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runIndex } from '../src/index/orchestrator.js';
import { openDatabase, applySchema } from '../src/db/schema.js';
import { QueryEngine } from '../src/query/engine.js';

// ── Helpers ────────────────────────────────────────────────────────────

function tmpProject(name: string): string {
  const dir = path.join(os.tmpdir(), `nexus-e2e-${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore cleanup errors */ }
}

function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ── End-to-end: TypeScript project ─────────────────────────────────────

describe('E2E: TypeScript project', () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = tmpProject('ts');

    // Create a .git dir so detectRoot finds this as project root
    fs.mkdirSync(path.join(projectDir, '.git'));

    writeFile(projectDir, 'src/utils.ts', `
export const VERSION = '1.0.0';

export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`);

    writeFile(projectDir, 'src/models/user.ts', `
import { VERSION } from '../utils.js';

export interface UserData {
  id: string;
  name: string;
  email: string;
}

export class UserService {
  private version = VERSION;

  findById(id: string): UserData | null {
    return null;
  }

  create(data: Omit<UserData, 'id'>): UserData {
    return { ...data, id: crypto.randomUUID() };
  }
}

export default UserService;
`);

    writeFile(projectDir, 'src/index.ts', `
export { add, multiply, VERSION } from './utils.js';
export { UserService } from './models/user.js';
export type { UserData } from './models/user.js';
`);
  });

  afterAll(() => {
    rmrf(projectDir);
  });

  it('indexes the project successfully', () => {
    const result = runIndex(projectDir);
    expect(result.mode).toBe('full');
    expect(result.filesIndexed).toBe(3);
    expect(result.filesErrored).toBe(0);
  });

  it('queries symbols after indexing', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      // Find a function
      const addResult = engine.find('add');
      expect(addResult.count).toBe(1);
      expect(addResult.results[0].kind).toBe('function');
      expect(addResult.results[0].file).toContain('utils.ts');

      // Find a class
      const classResult = engine.find('UserService');
      expect(classResult.count).toBeGreaterThanOrEqual(1);
      const classDef = classResult.results.find(r => r.kind === 'class');
      expect(classDef).toBeDefined();
      expect(classDef!.file).toContain('user.ts');

      // Find an interface
      const ifaceResult = engine.find('UserData', 'interface');
      expect(ifaceResult.count).toBe(1);
      expect(ifaceResult.results[0].file).toContain('user.ts');
    } finally {
      db.close();
    }
  });

  it('queries exports', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.exports('src/utils.ts');
      expect(result.count).toBeGreaterThanOrEqual(3);
      const names = result.results.map(r => r.name);
      expect(names).toContain('VERSION');
      expect(names).toContain('add');
      expect(names).toContain('multiply');
    } finally {
      db.close();
    }
  });

  it('queries imports', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.imports('src/models/user.ts');
      expect(result.count).toBeGreaterThanOrEqual(1);
      const sources = result.results.map(r => r.source);
      expect(sources).toContain('../utils.js');
    } finally {
      db.close();
    }
  });

  it('queries occurrences', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.occurrences('UserService');
      expect(result.count).toBeGreaterThanOrEqual(1);
      // Should appear in user.ts and index.ts
      const files = [...new Set(result.results.map(r => r.file))];
      expect(files.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('fuzzy search works', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.search('UserSrv');
      expect(result.count).toBeGreaterThanOrEqual(1);
      expect(result.results[0].name).toBe('UserService');
    } finally {
      db.close();
    }
  });

  it('tree lists all files', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.tree();
      expect(result.count).toBe(3);
      const paths = result.results.map(r => r.path);
      expect(paths.some(p => p.includes('utils.ts'))).toBe(true);
      expect(paths.some(p => p.includes('user.ts'))).toBe(true);
      expect(paths.some(p => p.includes('index.ts'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('stats reports correct counts', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.stats();
      const stats = result.results[0];
      expect(stats.files.indexed).toBe(3);
      expect(stats.files.errored).toBe(0);
      expect(stats.symbols_total).toBeGreaterThan(0);
      expect(stats.index_status).toBe('current');
      expect(stats.index_health).toBe('ok');
      expect(stats.languages.typescript).toBeDefined();
      expect(stats.languages.typescript.files).toBe(3);
    } finally {
      db.close();
    }
  });

  it('incremental indexing detects no changes', () => {
    const result = runIndex(projectDir);
    expect(result.mode).toBe('incremental');
    expect(result.filesIndexed).toBe(0);
  });

  it('incremental indexing picks up new file', () => {
    writeFile(projectDir, 'src/helper.ts', `
export function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}
`);

    const result = runIndex(projectDir);
    expect(result.mode).toBe('incremental');
    expect(result.filesIndexed).toBe(1);

    // Verify the new symbol is queryable
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const findResult = engine.find('clamp');
      expect(findResult.count).toBe(1);
      expect(findResult.results[0].file).toContain('helper.ts');
    } finally {
      db.close();
    }
  });
});

describe('E2E: component-local symbols', () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = tmpProject('tsx-local');
    fs.mkdirSync(path.join(projectDir, '.git'));

    writeFile(projectDir, 'src/KanbanBoard.tsx', `
import React from 'react';

export const KanbanBoard = () => {
  const activeTask = null;

  const handleDragStart = () => {
    return activeTask;
  };

  function handleDragEnd() {
    return handleDragStart();
  }

  return <div onClick={handleDragEnd}>{activeTask}</div>;
};
`);
  });

  afterAll(() => {
    rmrf(projectDir);
  });

  it('finds symbols declared inside component closures', () => {
    const result = runIndex(projectDir);
    expect(result.filesIndexed).toBe(1);

    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const activeTask = engine.find('activeTask');
      expect(activeTask.count).toBe(1);
      expect(activeTask.results[0].file).toContain('KanbanBoard.tsx');
      expect(activeTask.results[0].scope).toBe('KanbanBoard');

      const handleDragStart = engine.find('handleDragStart');
      expect(handleDragStart.count).toBe(1);
      expect(handleDragStart.results[0].kind).toBe('function');
      expect(handleDragStart.results[0].scope).toBe('KanbanBoard');

      const handleDragEnd = engine.find('handleDragEnd');
      expect(handleDragEnd.count).toBe(1);
      expect(handleDragEnd.results[0].kind).toBe('function');
      expect(handleDragEnd.results[0].scope).toBe('KanbanBoard');
    } finally {
      db.close();
    }
  });
});

// ── E2E: Multi-language project ────────────────────────────────────────

describe('E2E: Multi-language project', () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = tmpProject('multi');
    fs.mkdirSync(path.join(projectDir, '.git'));

    writeFile(projectDir, 'main.py', `
import os

MAX_SIZE = 1024

class Config:
    """Application configuration."""
    def __init__(self, name: str):
        self.name = name

    def validate(self) -> bool:
        return len(self.name) > 0

def load_config(path: str) -> Config:
    return Config(path)
`);

    writeFile(projectDir, 'main.go', `
package main

import "fmt"

// AppConfig holds application configuration.
type AppConfig struct {
    Name string
    Port int
}

func NewAppConfig(name string) *AppConfig {
    return &AppConfig{Name: name, Port: 8080}
}

func (c *AppConfig) Validate() bool {
    return c.Name != ""
}

func main() {
    cfg := NewAppConfig("myapp")
    fmt.Println(cfg.Name)
}
`);

    writeFile(projectDir, 'lib.rs', `
use std::collections::HashMap;

/// Maximum retry count.
pub const MAX_RETRIES: u32 = 3;

/// A configuration holder.
pub struct Config {
    name: String,
    settings: HashMap<String, String>,
}

impl Config {
    pub fn new(name: &str) -> Self {
        Config {
            name: name.to_string(),
            settings: HashMap::new(),
        }
    }

    pub fn get(&self, key: &str) -> Option<&String> {
        self.settings.get(key)
    }
}

pub fn create_config(name: &str) -> Config {
    Config::new(name)
}
`);

    writeFile(projectDir, 'App.java', `
import java.util.List;
import java.util.Optional;

public class App {
    public static final int MAX_CONNECTIONS = 100;

    /**
     * Entry point.
     */
    public static void main(String[] args) {
        System.out.println("Hello");
    }

    public Optional<String> findName(List<String> names, String query) {
        return names.stream().filter(n -> n.equals(query)).findFirst();
    }
}
`);

    writeFile(projectDir, 'Service.cs', `
using System;
using System.Collections.Generic;

namespace MyApp
{
    public class Service
    {
        public const int Timeout = 30;

        public string Process(string input)
        {
            return input.ToUpper();
        }
    }

    public interface IProcessor
    {
        void Execute();
    }
}
`);

    writeFile(projectDir, 'utils.ts', `
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`);
  });

  afterAll(() => {
    rmrf(projectDir);
  });

  it('indexes all languages', () => {
    const result = runIndex(projectDir);
    expect(result.filesIndexed).toBe(6);
    expect(result.filesErrored).toBe(0);
  });

  it('queries across languages', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      // Stats shows all languages
      const stats = engine.stats().results[0];
      expect(Object.keys(stats.languages)).toHaveLength(6);
      expect(stats.languages.python).toBeDefined();
      expect(stats.languages.go).toBeDefined();
      expect(stats.languages.rust).toBeDefined();
      expect(stats.languages.java).toBeDefined();
      expect(stats.languages.csharp).toBeDefined();
      expect(stats.languages.typescript).toBeDefined();

      // Find symbols across languages — "Config" appears in Python, Go, Rust
      const configResult = engine.find('Config', 'class');
      expect(configResult.count).toBeGreaterThanOrEqual(2);
      const languages = configResult.results.map(r => r.language);
      expect(languages).toContain('python');

      // Search across languages
      const searchResult = engine.search('Config');
      expect(searchResult.count).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
    }
  });

  it('tree shows all files with correct languages', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.tree();
      expect(result.count).toBe(6);

      const byLang = new Map<string, string[]>();
      for (const entry of result.results) {
        const langs = byLang.get(entry.language) ?? [];
        langs.push(entry.path);
        byLang.set(entry.language, langs);
      }

      expect(byLang.get('python')).toHaveLength(1);
      expect(byLang.get('go')).toHaveLength(1);
      expect(byLang.get('rust')).toHaveLength(1);
      expect(byLang.get('java')).toHaveLength(1);
      expect(byLang.get('csharp')).toHaveLength(1);
      expect(byLang.get('typescript')).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

// ── E2E: Windows path normalization ────────────────────────────────────

describe('E2E: Path normalization', () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = tmpProject('paths');
    fs.mkdirSync(path.join(projectDir, '.git'));

    writeFile(projectDir, 'src/deep/nested/module.ts', `
export class DeepModule {
  run(): void {}
}
`);
  });

  afterAll(() => {
    rmrf(projectDir);
  });

  it('indexes nested paths', () => {
    const result = runIndex(projectDir);
    expect(result.filesIndexed).toBe(1);
  });

  it('finds file with forward slashes', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.exports('src/deep/nested/module.ts');
      expect(result.count).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('finds file with backslash path', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.exports('src\\deep\\nested\\module.ts');
      expect(result.count).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('finds file with partial path', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.exports('nested/module.ts');
      expect(result.count).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('tree with path prefix uses forward slashes', () => {
    const dbPath = path.join(projectDir, '.nexus', 'index.db');
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.tree('src/deep');
      expect(result.count).toBe(1);
      // Path in DB should use forward slashes
      expect(result.results[0].path).toContain('/');
      expect(result.results[0].path).not.toContain('\\');
    } finally {
      db.close();
    }
  });
});

// ── E2E: Self-index (Nexus indexes its own source) ────────────────────

describe('E2E: Self-index', () => {
  const nexusRoot = path.resolve(__dirname, '..');
  let dbPath: string;

  beforeAll(() => {
    // Index nexus's own src/ by running from the repo root
    const result = runIndex(nexusRoot, true);
    expect(result.filesErrored).toBe(0);
    dbPath = path.join(nexusRoot, '.nexus', 'index.db');
  });

  afterAll(() => {
    // Clean up the .nexus directory
    rmrf(path.join(nexusRoot, '.nexus'));
  });

  it('indexes nexus source files', () => {
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const stats = engine.stats().results[0];
      // Should have at least the src/ TypeScript files
      expect(stats.files.indexed).toBeGreaterThanOrEqual(10);
      expect(stats.languages.typescript).toBeDefined();
      expect(stats.languages.typescript.files).toBeGreaterThanOrEqual(10);
    } finally {
      db.close();
    }
  });

  it('finds functions from cleanly-parsed files', () => {
    // Note: tree-sitter-typescript@0.23.2 fails on `import type X from '...'`
    // (type-only default imports). Files using this syntax have degraded extraction.
    // We test with files that use standard import syntax.
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      // runIndex is in orchestrator.ts (uses standard imports)
      const result = engine.find('runIndex', 'function');
      expect(result.count).toBe(1);
      expect(result.results[0].file).toContain('orchestrator.ts');
    } finally {
      db.close();
    }
  });

  it('finds config interfaces', () => {
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.find('NexusConfig', 'interface');
      expect(result.count).toBe(1);
      expect(result.results[0].file).toContain('config.ts');
    } finally {
      db.close();
    }
  });

  it('finds symbols across multiple files', () => {
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.find('loadConfig', 'function');
      expect(result.count).toBe(1);

      const scan = engine.find('scanDirectory', 'function');
      expect(scan.count).toBe(1);
      expect(scan.results[0].file).toContain('scanner.ts');
    } finally {
      db.close();
    }
  });

  it('finds occurrences across files', () => {
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.occurrences('runIndex');
      expect(result.count).toBeGreaterThanOrEqual(3);
      const files = [...new Set(result.results.map(r => r.file))];
      expect(files.length).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });

  it('search finds relevant results', () => {
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.search('loadConfig');
      expect(result.count).toBeGreaterThanOrEqual(1);
      expect(result.results[0].name).toBe('loadConfig');
    } finally {
      db.close();
    }
  });

  it('tree shows adapter files', () => {
    const db = openDatabase(dbPath);
    applySchema(db);
    const engine = new QueryEngine(db);

    try {
      const result = engine.tree('src/analysis/languages');
      expect(result.count).toBeGreaterThanOrEqual(6);
      const paths = result.results.map(r => r.path);
      expect(paths.some(p => p.includes('typescript.ts'))).toBe(true);
      expect(paths.some(p => p.includes('python.ts'))).toBe(true);
      expect(paths.some(p => p.includes('go.ts'))).toBe(true);
    } finally {
      db.close();
    }
  });
});
