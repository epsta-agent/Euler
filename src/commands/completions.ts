/**
 * Completions command - Following oh-my-pi CLI architecture
 * Shell completions for Euler Agent
 */

export default {
  name: 'completions',
  description: 'Shell completions',
  handler: async (args: string[]) => {
    const shell = args?.[0];

    if (!shell) {
      return `Usage: euler completions <shell>

Generate shell completion scripts for Euler Agent.

Supported shells:
  bash    Generate completions for bash
  zsh     Generate completions for zsh
  fish    Generate completions for fish

Example:
  euler completions bash > /etc/bash_completion.d/euler
  euler completions zsh > /usr/local/share/zsh/site-functions/_euler`;
    }

    switch (shell) {
      case 'bash':
        return `# Euler bash completions
_euler_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local commands="launch acp agents commit completions config grep read shell ssh stats search plugin setup worktree update"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=(\$(compgen -W "\$commands" -- "\$cur"))
  else
    case "\${COMP_WORDS[1]}" in
      config)
        COMPREPLY=(\$(compgen -W "get set edit show" -- "\$cur"))
        ;;
      plugin)
        COMPREPLY=(\$(compgen -W "list install uninstall update" -- "\$cur"))
        ;;
      worktree|wt)
        COMPREPLY=(\$(compgen -W "list add remove prune" -- "\$cur"))
        ;;
    esac
  fi
}

complete -F _euler_completions euler`;

      case 'zsh':
        return `#compdef euler

_euler() {
  local -a commands
  commands=(
    'launch:Launch interactive session'
    'acp:Agent Client Protocol mode'
    'agents:Subagent coordination'
    'commit:Atomic commit generation'
    'completions:Shell completions'
    'config:Configuration management'
    'grep:Fast file search'
    'read:File reader utility'
    'shell:Shell command utility'
    'ssh:Remote command execution'
    'stats:Usage statistics'
    'search:Web search'
    'plugin:Plugin management'
    'setup:Initial setup wizard'
    'worktree:Git worktree operations'
    'update:Update Euler Agent'
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
  else
    case "\${words[2]}" in
      config)
        _values 'subcommand' get set edit show
        ;;
      plugin)
        _values 'subcommand' list install uninstall update
        ;;
      worktree|wt)
        _values 'subcommand' list add remove prune
        ;;
    esac
  fi
}

_euler`;

      case 'fish':
        return `# Euler fish completions

complete -c euler -f

complete -c euler -n "__fish_use_subcommand" -a launch -d "Launch interactive session"
complete -c euler -n "__fish_use_subcommand" -a acp -d "Agent Client Protocol mode"
complete -c euler -n "__fish_use_subcommand" -a agents -d "Subagent coordination"
complete -c euler -n "__fish_use_subcommand" -a commit -d "Atomic commit generation"
complete -c euler -n "__fish_use_subcommand" -a completions -d "Shell completions"
complete -c euler -n "__fish_use_subcommand" -a config -d "Configuration management"
complete -c euler -n "__fish_use_subcommand" -a grep -d "Fast file search"
complete -c euler -n "__fish_use_subcommand" -a read -d "File reader utility"
complete -c euler -n "__fish_use_subcommand" -a shell -d "Shell command utility"
complete -c euler -n "__fish_use_subcommand" -a ssh -d "Remote command execution"
complete -c euler -n "__fish_use_subcommand" -a stats -d "Usage statistics"
complete -c euler -n "__fish_use_subcommand" -a search -d "Web search"
complete -c euler -n "__fish_use_subcommand" -a plugin -d "Plugin management"
complete -c euler -n "__fish_use_subcommand" -a setup -d "Initial setup wizard"
complete -c euler -n "__fish_use_subcommand" -a worktree -d "Git worktree operations"
complete -c euler -n "__fish_use_subcommand" -a update -d "Update Euler Agent"

# Config subcommands
complete -c euler -n "__fish_seen_subcommand_string config" -a get -d "Get config value"
complete -c euler -n "__fish_seen_subcommand_string config" -a set -d "Set config value"
complete -c euler -n "__fish_seen_subcommand_string config" -a edit -d "Edit config file"
complete -c euler -n "__fish_seen_subcommand_string config" -a show -d "Show all config"

# Plugin subcommands
complete -c euler -n "__fish_seen_subcommand_string plugin" -a list -d "List plugins"
complete -c euler -n "__fish_seen_subcommand_string plugin" -a install -d "Install plugin"
complete -c euler -n "__fish_seen_subcommand_string plugin" -a uninstall -d "Uninstall plugin"
complete -c euler -n "__fish_seen_subcommand_string plugin" -a update -d "Update plugins"`;

      default:
        return `Unsupported shell: ${shell}\nSupported shells: bash, zsh, fish`;
    }
  }
};
