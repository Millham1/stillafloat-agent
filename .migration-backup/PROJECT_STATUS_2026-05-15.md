# Still Afloat Agent — Project Status (2026-05-15)

## Major Architectural Change

The AI editorial system was extracted from the website repo into a standalone backend service:

- Frontend repo:
  - `stillafloatcruising-com`
- AI backend repo:
  - `stillafloat-agent`

This separates:
- presentation layer
- editorial intelligence
- ingestion
- approvals
- publishing orchestration

## What Was Built Tonight

### Standalone AI Agent Structure

Created:
- `/src`
- `/api`
- standalone package structure
- standalone Vercel deployment target

### Editorial Intelligence

Added:
- editorial directives
- AI orchestration runner
- source registry
- semantic clustering
- duplicate collapse
- operational alert prioritization
- autonomous scheduling intelligence
- content opportunity generation
- editorial analytics

### Publishing System

Added:
- homepage feed generator
- news index generator
- story detail generator
- publishing bundle orchestration

### Persistence Layer

Added:
- candidate story storage
- approved story storage
- archive storage
- homepage feed persistence
- story detail persistence

### Approval Workflow

Added:
- approve
- reject
- pin
- defer
- token authorization
- publishing validation
- duplicate approval protection
- archive rollover

### Email System

Added:
- Resend integration
- editorial digest renderer
- approval workflow email generation

### Hardening

Added:
- schema normalization
- URL validation
- HTML/script stripping
- duplicate prevention
- malformed payload protection
- safe publishing validation

## Remaining Critical Tasks

### Vercel Setup

Still required:
- create standalone Vercel project:
  - `stillafloat-agent`
- import environment variables
- deploy standalone backend
- verify deployment URLs

### Frontend Integration

Still required in `stillafloatcruising-com`:

#### Homepage
- consume homepage feed
- dynamic story cards
- operational alert section
- homepage refresh behavior

#### News Page
- consume news-index feed
- grouped developments
- category rendering
- featured story logic

#### Story Detail Pages
- consume story-details feed
- render AI synopsis
- render traveler impact
- render source attribution
- verify original source links

### Live Workflow Verification

Must verify end-to-end:

1. live scan
2. AI curation
3. approval email delivery
4. approve/reject actions
5. publishing persistence
6. homepage update
7. story page rendering
8. source-link accuracy

## Architectural Direction (Now Stable)

### stillafloat-agent
Owns:
- ingestion
- AI reasoning
- approvals
- persistence
- publishing
- scheduling
- alerts
- analytics
- email

### stillafloatcruising-com
Owns:
- branding
- homepage rendering
- story rendering
- cruise tools
- UI/UX
- presentation

## Important Lessons Learned Tonight

1. AI-first editorial reasoning is required.
2. Keyword scoring systems are insufficient.
3. The website should NOT contain editorial intelligence.
4. The AI backend must be independent.
5. The approval workflow is the operational backbone.
6. Stability and normalization matter more than speed.
7. Real demos require end-to-end integration, not JSON endpoints.
