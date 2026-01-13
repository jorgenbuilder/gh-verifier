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

interface CommentaryPayload {
  commentary: CommentarySchema;
  metadata: {
    cost_usd: number;
    duration_ms: number;
    turns: number;
  };
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

async function postCommentary() {
  const outputPath = process.argv[2] || '/home/runner/work/_temp/claude-execution-output.json';
  const proposalId = process.argv[3];
  const portalUrl = process.env.PORTAL_URL;
  const commentarySecret = process.env.COMMENTARY_SECRET;

  // Validate required arguments
  if (!proposalId) {
    console.error('Error: Missing proposal ID argument');
    console.error('Usage: npx tsx src/post-commentary.ts <output-path> <proposal-id>');
    process.exit(1);
  }

  if (!portalUrl) {
    console.error('Error: PORTAL_URL environment variable not set');
    process.exit(1);
  }

  if (!commentarySecret) {
    console.error('Error: COMMENTARY_SECRET environment variable not set');
    process.exit(1);
  }

  try {
    // Parse Claude output
    console.log(`Parsing commentary from ${outputPath}...`);
    const { commentary, cost, duration, turns } = parseClaudeOutput(outputPath);

    if (!commentary) {
      console.warn('Warning: Could not extract commentary JSON from Claude output');
      console.warn('Skipping POST to portal');
      process.exit(0);
    }

    // Verify proposal ID matches
    if (commentary.proposal_id !== proposalId) {
      console.warn(`Warning: Proposal ID mismatch (expected ${proposalId}, got ${commentary.proposal_id})`);
      console.warn('Using proposal ID from command line argument');
      commentary.proposal_id = proposalId;
    }

    // Build payload
    const payload: CommentaryPayload = {
      commentary,
      metadata: {
        cost_usd: cost,
        duration_ms: duration,
        turns: turns
      }
    };

    // POST to portal API
    const url = `${portalUrl}/api/proposals/${proposalId}/commentary`;
    console.log(`Posting commentary to ${url}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${commentarySecret}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    console.log('✓ Commentary posted successfully');
    console.log(`  Commentary ID: ${result.commentary_id}`);
    console.log(`  Created at: ${result.created_at}`);
    console.log(`  Cost: $${cost.toFixed(2)}`);
    console.log(`  Duration: ${Math.floor(duration / 1000)}s`);
    console.log(`  Turns: ${turns}`);

  } catch (err) {
    console.error('❌ Failed to post commentary:', err);
    process.exit(1);
  }
}

postCommentary();
