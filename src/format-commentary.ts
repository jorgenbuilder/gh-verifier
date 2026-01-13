import { readFileSync } from 'fs';

interface CommentarySchema {
  title: string;
  proposal_id: string;
  canister_id?: string;
  commit_summaries?: Array<{
    commit_hash: string;
    summary: string;
  }>;
  file_summaries?: Array<{
    file_path: string;
    summary: string;
  }>;
  overall_summary: string;
  why_now?: string;
  sources: Array<{
    type: string;
    url?: string;
    description: string;
  }>;
  confidence_notes?: string;
  analysis_incomplete: boolean;
  incomplete_reason?: string;
}

interface Turn {
  type: string;
  subtype?: string;
  message?: {
    content: Array<{ type: string; text?: string }>;
  };
  cost_usd?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
}

function extractJsonFromText(text: string): CommentarySchema | null {
  // Try to find JSON object in the text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      // Verify it looks like our schema
      if (parsed.title && parsed.overall_summary) {
        return parsed;
      }
    } catch {
      // Not valid JSON
    }
  }
  return null;
}

function parseClaudeOutput(outputPath: string): { commentary: CommentarySchema | null; cost: number; duration: number; turns: number } {
  const raw = readFileSync(outputPath, 'utf-8');
  const turns: Turn[] = JSON.parse(raw);

  let cost = 0;
  let duration = 0;
  let numTurns = 0;
  let commentary: CommentarySchema | null = null;

  // Process turns
  for (const turn of turns) {
    // Get stats from result turn
    if (turn.type === 'result') {
      cost = turn.total_cost_usd || turn.cost_usd || 0;
      duration = turn.duration_ms || 0;
      numTurns = turn.num_turns || 0;
    }

    // Look for commentary JSON in assistant messages
    if (turn.type === 'assistant' && turn.message?.content) {
      for (const item of turn.message.content) {
        if (item.type === 'text' && item.text) {
          const found = extractJsonFromText(item.text);
          if (found) {
            commentary = found;
          }
        }
      }
    }
  }

  return { commentary, cost, duration, turns: numTurns };
}

function formatSourceLink(source: { type: string; url?: string; description: string }): string {
  const typeEmoji: Record<string, string> = {
    proposal_body: '📜',
    git_diff: '🔀',
    github_pr: '🔗',
    forum_post: '💬',
    documentation: '📚',
    other: '📎',
  };

  const emoji = typeEmoji[source.type] || '📎';

  if (source.url) {
    return `- ${emoji} [${source.description}](${source.url})`;
  }
  return `- ${emoji} ${source.description}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

function formatCommentaryAsMarkdown(commentary: CommentarySchema, cost: number, duration: number, turns: number): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${commentary.title}`);
  lines.push('');

  // Metadata
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| **Proposal** | ${commentary.proposal_id} |`);
  if (commentary.canister_id) {
    lines.push(`| **Canister** | \`${commentary.canister_id}\` |`);
  }
  lines.push(`| **Analysis Cost** | $${cost.toFixed(2)} |`);
  lines.push(`| **Duration** | ${formatDuration(duration)} |`);
  lines.push(`| **Turns** | ${turns} |`);
  lines.push('');

  // Warning if incomplete
  if (commentary.analysis_incomplete) {
    lines.push('> ⚠️ **Analysis Incomplete**');
    if (commentary.incomplete_reason) {
      lines.push(`> ${commentary.incomplete_reason}`);
    }
    lines.push('');
  }

  // Overall Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(commentary.overall_summary);
  lines.push('');

  // Why Now
  if (commentary.why_now) {
    lines.push('## Why Now');
    lines.push('');
    lines.push(commentary.why_now);
    lines.push('');
  }

  // Commit Summaries
  if (commentary.commit_summaries && commentary.commit_summaries.length > 0) {
    lines.push('## Commits');
    lines.push('');
    for (const commit of commentary.commit_summaries) {
      const shortHash = commit.commit_hash.substring(0, 8);
      lines.push(`### [\`${shortHash}\`](https://github.com/dfinity/ic/commit/${commit.commit_hash})`);
      lines.push('');
      lines.push(commit.summary);
      lines.push('');
    }
  }

  // File Summaries
  if (commentary.file_summaries && commentary.file_summaries.length > 0) {
    lines.push('<details>');
    lines.push('<summary><strong>File Changes</strong></summary>');
    lines.push('');
    for (const file of commentary.file_summaries) {
      lines.push(`#### \`${file.file_path}\``);
      lines.push('');
      lines.push(file.summary);
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
  }

  // Sources
  if (commentary.sources && commentary.sources.length > 0) {
    lines.push('## Sources');
    lines.push('');
    for (const source of commentary.sources) {
      lines.push(formatSourceLink(source));
    }
    lines.push('');
  }

  // Confidence Notes
  if (commentary.confidence_notes) {
    lines.push('---');
    lines.push('');
    lines.push(`> **Note:** ${commentary.confidence_notes}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('*Generated by [Claude Code](https://claude.ai/code)*');

  return lines.join('\n');
}

async function main() {
  const outputPath = process.argv[2] || '/home/runner/work/_temp/claude-execution-output.json';

  try {
    const { commentary, cost, duration, turns } = parseClaudeOutput(outputPath);

    if (!commentary) {
      console.log('## ⚠️ Commentary Generation Issue');
      console.log('');
      console.log('Could not extract structured commentary JSON from Claude output.');
      console.log('');
      console.log(`Analysis ran for ${formatDuration(duration)} (${turns} turns, $${cost.toFixed(2)})`);
      console.log('');
      console.log('Check the workflow logs for details.');
      process.exit(0);
    }

    const markdown = formatCommentaryAsMarkdown(commentary, cost, duration, turns);
    console.log(markdown);

  } catch (err) {
    console.error('Error formatting commentary:', err);
    console.log('## ❌ Formatting Error');
    console.log('');
    console.log('Failed to parse Claude output file.');
    process.exit(1);
  }
}

main();
