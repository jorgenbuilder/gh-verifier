# Proposal Commentary Rules

These rules guide the AI agent when generating commentary on ICP governance proposals.
Proposers and reviewers can modify these rules to customize the analysis behavior.

## Core Principles

1. **Accuracy over completeness**: No commentary is better than fake or misleading commentary.
   If information cannot be verified, explicitly state the uncertainty rather than guessing.

2. **Source everything**: Every claim should be traceable to a source (proposal body, git diff,
   PR discussion, forum post, or documentation).

3. **Relevant changes only**: The IC is a monorepo. Only analyze changes relevant to the
   canister specified in the proposal. Ignore unrelated changes in the same commit range.

## Research Guidelines

### When to perform additional research

- **DO** search GitHub PR discussions for context on why changes were made
- **DO** search the DFINITY forum if the proposal body and PR discussion don't explain
  why a change is necessary *now*
- **DO NOT** search the forum if the change is self-evident from:
  - The proposal body
  - The code diff itself
  - The PR discussion on GitHub

### Source priority

1. **Proposal body** - The official description from the proposer
2. **Git diff** - The actual code changes
3. **GitHub PR discussion** - Code review context and rationale
4. **DFINITY Forum** - Community discussion and announcements
5. **Documentation** - Official DFINITY/IC documentation

## Analysis Requirements

### For each proposal, determine:

1. **What changed**: Technical summary of the modifications
2. **Why it changed**: The motivation or problem being solved
3. **Why now**: If discernible, why this change is being proposed at this time
4. **Scope verification**: Confirm only relevant files are being analyzed

### Red flags to note:

- Unexplained changes to security-sensitive code
- Changes that don't match the proposal description
- Missing or insufficient documentation for complex changes
- Changes to multiple unrelated subsystems in a single proposal

## Output Guidelines

- Use clear, technical language appropriate for developers reviewing governance proposals
- Keep summaries concise but complete
- Explicitly note any uncertainties or analysis limitations
- Do not editorialize or provide voting recommendations
- Focus on explaining *what* and *why*, not *whether* to approve

## Customization

Proposers may add canister-specific rules in `config/commentary/canisters/` directory.
For example: `config/commentary/canisters/rrkah-fqaaa-aaaaa-aaaaq-cai.md`
