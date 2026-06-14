/**
 * Tool Registry - following oh-my-pi's tool discovery architecture
 */

import { Tool, ToolRegistry, ToolDiscovery, ToolExecutionContext } from './types';

class BM25Discovery implements ToolDiscovery {
  private corpus: { tool: Tool; text: string }[] = [];

  indexTools(tools: Tool[]): void {
    this.corpus = tools.map(tool => ({
      tool,
      text: `${tool.name} ${tool.description} ${tool.parameters.map(p => p.name + ' ' + p.description).join(' ')}`.toLowerCase()
    }));
  }

  search(query: string, tools: Tool[], limit: number = 5): Tool[] {
    const queryLower = query.toLowerCase();
    const scores = this.corpus.map(({ tool, text }) => {
      const queryTerms = queryLower.split(/\s+/);
      let score = 0;

      queryTerms.forEach(term => {
        if (text.includes(term)) {
          score += 1;
          // Bonus for exact name match
          if (tool.name.toLowerCase() === term) {
            score += 3;
          }
        }
      });

      return { tool, score };
    });

    return scores
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.tool);
  }
}

class DefaultToolRegistry implements ToolRegistry {
  public core = new Map<string, Tool>();
  public discoverable = new Map<string, Tool>();
  public optional = new Map<string, Tool>();
  private activated = new Set<string>();
  private discovery: ToolDiscovery;

  constructor() {
    this.discovery = new BM25Discovery();
  }

  register(tool: Tool): void {
    switch (tool.category) {
      case 'core':
        this.core.set(tool.name, tool);
        break;
      case 'discoverable':
        this.discoverable.set(tool.name, tool);
        break;
      case 'optional':
        this.optional.set(tool.name, tool);
        break;
    }

    // Re-index discoverable tools
    this.discovery.indexTools(Array.from(this.discoverable.values()));
  }

  get(name: string): Tool | undefined {
    if (this.core.has(name)) return this.core.get(name);
    if (this.discoverable.has(name)) return this.discoverable.get(name);
    if (this.optional.has(name)) return this.optional.get(name);
    return undefined;
  }

  discover(query: string, limit: number = 5): Tool[] {
    return this.discovery.search(query, Array.from(this.discoverable.values()), limit);
  }

  getActive(): Tool[] {
    const active = Array.from(this.core.values());

    // Add activated discoverable tools
    this.activated.forEach(name => {
      const tool = this.discoverable.get(name);
      if (tool) active.push(tool);
    });

    return active;
  }

  activate(name: string): boolean {
    const tool = this.discoverable.get(name) || this.optional.get(name);
    if (tool) {
      this.activated.add(name);
      return true;
    }
    return false;
  }

  deactivate(name: string): void {
    this.activated.delete(name);
  }

  // Get all tools for listing
  getAll(): Tool[] {
    return [
      ...Array.from(this.core.values()),
      ...Array.from(this.discoverable.values()),
      ...Array.from(this.optional.values())
    ];
  }

  // Get tools by category
  getByCategory(category: 'core' | 'discoverable' | 'optional'): Tool[] {
    switch (category) {
      case 'core':
        return Array.from(this.core.values());
      case 'discoverable':
        return Array.from(this.discoverable.values());
      case 'optional':
        return Array.from(this.optional.values());
    }
  }
}

// Global tool registry instance
export const toolRegistry = new DefaultToolRegistry();

// Export the registry class for testing
export { DefaultToolRegistry };
