# Image Gen Project Steering

## Core Information
TODO: fill this out

## Code guidelines
- When committing changes, include any updates in `STEERING.md` file and `.agents` folder, as well as other docs: `TROUBLESHOOTING.md`, `CHANGELOG.md`, `TODO.md`
- Don't include co-author line on commits, ie. `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"` - leave this out, not necessary for commit messages
- Claude API model selection
    - NEVER use Opus 4 (`claude-opus-4-*`) - it is extremely expensive compared to Sonnet 4. Use Opus 4.5 (`claude-opus-4-5-*`) if you need the highest capability tier.
    - Default model should be Opus 4.5 or Sonnet 4.5. Constants are in `claude_api_client.cpp`.

## Project Proposal
TODO: fill this out

## Open Tasks
**Please see `TODO.md` for list of current and closed tasks.**

## Latest Updates
**Please see `CHANGELOG.md` for list of latest updates.**

## Key Learnings & Common Issues
**Please see `TROUBLESHOOTING.md` for key learnings and common issues.**

## Core Architecture
TODO: fill this out

## Key Files Reference
TODO: fill this out
