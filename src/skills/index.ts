/**
 * Skills system
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import matter from 'gray-matter';

export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private searchPaths: string[] = [];

  constructor() {
    this.addSearchPath(resolve(process.cwd(), '.euler', 'skills'));
    this.addSearchPath(resolve(process.env.HOME || '~', '.euler', 'skills'));
    this.load();
  }

  addSearchPath(path: string): void {
    if (!this.searchPaths.includes(path)) {
      this.searchPaths.push(path);
      this.load();
    }
  }

  load(): void {
    for (const searchPath of this.searchPaths) {
      if (!existsSync(searchPath)) continue;

      const entries = readdirSync(searchPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const filePath = join(searchPath, entry.name);
        const content = readFileSync(filePath, 'utf-8');
        const { data, content: markdown } = matter(content);

        if (data.name && data.description) {
          const skill: Skill = {
            name: data.name as string,
            description: data.description as string,
            content: markdown.trim(),
            filePath,
          };

          this.skills.set(skill.name, skill);
        }
      }
    }
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  search(query: string): Skill[] {
    const lowerQuery = query.toLowerCase();
    return this.list().filter(skill =>
      skill.name.toLowerCase().includes(lowerQuery) ||
      skill.description.toLowerCase().includes(lowerQuery)
    );
  }
}

export const skillRegistry = new SkillRegistry();
