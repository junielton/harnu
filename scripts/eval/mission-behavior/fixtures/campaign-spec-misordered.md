# Page publishing — spec

Synthetic spec for the `campaign-prereq-order` behavior scenario (campaign chapter 3b). It is
copied into the sandbox repo as `docs/page-publishing-spec.md`; nothing in it is real.

## Objective

Publish the Acme product pages from the new page templates.

## Delivery

Two chapters. The operator numbered them in the order the work was first discussed.

## Chapter 1 — Publish the pages

Publish every product page. Consumes `page-templates`.

- AC-1 — every product page is served from its template — verify: test

## Chapter 2 — Build the page templates

Build the page templates the pages render from. Produces `page-templates`.

- AC-2 — each template renders a sample product — verify: test
- AC-3 — a template with a missing field renders a visible placeholder — verify: visual
