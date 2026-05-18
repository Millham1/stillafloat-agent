# Still Afloat — PROJECT_CONTEXT

## Platform Vision

Still Afloat is an AI-assisted cruise and travel media platform focused on:
- cruise intelligence
- cruise news
- travel operations
- itinerary insights
- ship tracking
- weather awareness
- editorial curation
- future affiliate monetization
- future CRM/subscriber engagement

The platform is intended to evolve into a lightweight media operations system rather than just a static website.

## Founder Context

The founder:
- is a retired senior IT manager
- is a veteran
- has lived aboard a sailboat for 12 years
- has 20+ years of cruise experience
- prefers conversational AI-assisted workflows
- does NOT want to manually code

## Core Operational Philosophy

The system should:
- automate repetitive work
- preserve human editorial control
- operate reliably from mobile devices
- support future scaling
- avoid unnecessary complexity

## Current Infrastructure Stack

- Hosting: Vercel
- Source Control: GitHub
- AI / Editorial: OpenAI APIs
- Email Delivery: Resend
- Persistence: Supabase
- AI Development Environment: Replit

## Existing Functional Systems

### News Ingestion
- AI news scanning works
- story normalization works
- AI curation works

### Persistence
- stories persist correctly
- approved story queues exist
- candidate story queues exist

### Email Delivery
- Resend integration works
- verified sending domain works
- digest emails deliver successfully

### Editorial Workflow Backend
- story-status endpoint exists
- compact routing exists
- approve / hold / feature workflow exists

## Editorial Workflow Vision

1. AI scans news sources
2. AI curates candidate stories
3. Editorial digest email is sent
4. User opens mobile editorial dashboard
5. User approves, holds, or features stories
6. Approved stories feed homepage and news feed
7. Featured stories receive homepage priority

## Mobile-First Requirement

The founder must be able to:
- review stories from iPhone
- approve content while traveling
- manage editorial flow remotely
- avoid touching raw code

## Dashboard Requirements

The editorial dashboard should:
- be mobile friendly
- render real persisted stories
- never use placeholder data
- support Approve / Hold / Feature
- update persistence live
- show operational status

## Existing Routes

- /api/scan-news
- /api/story-status
- /api/editorial-dashboard

## Compact Editorial Routing

- ?c=a → approve
- ?c=h → hold
- ?c=f → feature

## Current Priority

Complete the mobile editorial workflow end-to-end.

This means:
- dashboard renders real stories
- actions mutate persistence
- email links correctly open dashboard
- approved stories display correctly
- featured stories receive priority

## Important Lessons

Do NOT rely on GitHub connector workflows for primary development.

Replit is now the preferred execution environment for active development.
GitHub remains source control.

## Success Criteria

The platform is considered operational when:
- editorial dashboard works on mobile
- stories flow end-to-end
- approvals persist correctly
- homepage reflects featured stories
- digest emails reliably link to dashboard
- founder can operate system without coding
