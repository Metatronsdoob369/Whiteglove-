# WhiteGlove Healthcare Outbound — Positive-Reply Response Pack (25_)

**Purpose:** Convert positive replies into booked demos and pilot packet sends the same day.  
**Use with:** `22_` run sheet, `23_` scoreboard, `24_` execution log.

---

## 1) Qualification quick-check (before replying)

Mark all that apply:
- [ ] Buyer appears to own or influence pilot decision
- [ ] Use case is healthcare policy/protocol/knowledge retrieval
- [ ] On-prem/compliance posture is relevant
- [ ] Team can attend a 20-minute technical risk review

If 3+ are checked, treat as qualified positive.

---

## 2) Same-day reply templates (copy/paste)

### A. Positive reply — direct booking ask

Subject: Re: [original subject]

Hi [Name],

Appreciate the response. The fastest next step is a 20-minute technical risk review + short demo tailored to [Org].

I can do:
- [Option A: Day, Time, TZ]
- [Option B: Day, Time, TZ]

If one works, I’ll send an invite and a 1-page prep note.

Best,
[Your Name]

---

### B. Positive but vague — narrow to one concrete use case

Subject: Re: [original subject]

Hi [Name],

Great to hear. To keep this practical, we usually anchor on one workflow first (for example: protocol retrieval, policy retrieval, or compliance evidence lookup).

If helpful, we can use a 20-minute session to map one concrete use case and confirm fit.

Open slots:
- [Option A]
- [Option B]

Best,
[Your Name]

---

### C. “Send more info first” response

Subject: Re: [original subject]

Hi [Name],

Absolutely — sharing concise materials below:
- Technical datasheet: `docs/launch_package/01_whiteglove_datasheet.md`
- Healthcare summary: `docs/launch_package/11_whiteglove_executive_summary_healthcare_hipaa.md`
- Compliance mapping: `docs/launch_package/07_whiteglove_compliance.md`

If useful, I can walk your team through relevance to [Org] in 20 minutes:
- [Option A]
- [Option B]

Best,
[Your Name]

---

### D. “Talk to my team” forwarding response

Subject: Re: [original subject]

Hi [Name],

Thank you — happy to coordinate with your team.

For the first review, ideal attendees are:
- clinical/quality owner
- IT/informatics owner
- compliance/security reviewer

I can hold 20 minutes at:
- [Option A]
- [Option B]

Best,
[Your Name]

---

## 3) Calendar booking script (internal)

When they accept a slot:
1. Send invite within 15 minutes.
2. Title: `WhiteGlove x [Org] — 20-min Technical Risk Review`.
3. Invite body:
   - Objective: evaluate fit for fixed-scope 30-day pilot
   - Agenda (20 min):
     1) use-case scope (5)
     2) known-hit/no-match demo path (8)
     3) pilot structure + success metrics (7)
4. Attach/link:
   - `02_` demo script
   - `11_` healthcare executive summary

---

## 4) Meeting flow (live)

Use this talk track:
1. Confirm pain in one sentence.
2. Show contract: source-cited retrieval + silence on no-match.
3. Show auditability: snapshot + traceability.
4. Close with pilot recommendation (Starter/Standard/Enterprise).
5. Ask explicit next step: “Should we send SOW + order form for legal review this week?”

---

## 5) Same-day post-meeting send block

Send within **2 hours** after a qualified meeting.

Subject: WhiteGlove pilot packet for [Org]

Hi [Name],

Thanks again for today. As discussed, sharing the pilot packet:
- SOW: `docs/launch_package/15_whiteglove_healthcare_pilot_sow.md`
- Order Form: `docs/launch_package/16_whiteglove_healthcare_pilot_order_form.md`
- Success Metrics Appendix: `docs/launch_package/17_whiteglove_healthcare_pilot_success_metrics.md`

If helpful, we can run a 30-minute commercial/legal working session to finalize scope and dates.

Available:
- [Option A]
- [Option B]

Best,
[Your Name]

---

## 6) CRM updates (required)

For every positive reply:
- `reply_status = positive`
- `meeting_booked = yes/no`
- `next_action_date = [date]`
- `stage = [Intro / Demo / Proposal / Negotiation]`
- `packet_sent = yes/no`

---

## 7) SLA targets

- Positive reply -> first response: **<= 2 business hours**
- Accepted slot -> calendar invite: **<= 15 minutes**
- Qualified meeting complete -> pilot packet sent: **<= 2 hours**

---

## 8) Escalation triggers

Escalate same day if:
- Buyer asks security/compliance deep dive -> send `06_` + `07_` and offer dedicated security call.
- Buyer asks pricing quickly -> send tier recommendation with one sentence rationale.
- Buyer asks legal edits -> move to redline docs `18_` `19_` `20_` variants for negotiation.
