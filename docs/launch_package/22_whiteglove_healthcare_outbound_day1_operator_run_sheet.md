# WhiteGlove Healthcare Outbound — Day 1 Operator Run Sheet

**Purpose:** Execute Day 1 of the healthcare outbound sprint with zero ambiguity.  
**Repo SHA (reference):** `56f6a02`  
**Owner:** [Name]  
**Date:** [YYYY-MM-DD]

---

## Inputs (must be ready before start)

- Target list: `docs/launch_package/18_whiteglove_healthcare_outbound_targets.md`
- Day 1 openers: `docs/launch_package/19_whiteglove_healthcare_outreach_day1_emails.md`
- 72-hour follow-ups: `docs/launch_package/20_whiteglove_healthcare_outreach_followup_emails.md`
- CRM import file: `docs/launch_package/21_whiteglove_healthcare_outreach_crm_export.csv`
- Pilot SOW: `docs/launch_package/15_whiteglove_healthcare_pilot_sow.md`
- Pilot Order Form: `docs/launch_package/16_whiteglove_healthcare_pilot_order_form.md`
- Success Metrics Appendix: `docs/launch_package/17_whiteglove_healthcare_pilot_success_metrics.md`
- Demo beat sheet: `docs/launch_package/02_whiteglove_demo_script.md`

---

## Day 1 Sequence

### 1) Import + prep (30-45 min)

1. Import `21_...csv` into Google Sheets/HubSpot/Apollo.
2. Verify all 7 columns mapped correctly:
   - org
   - role
   - day1_subject
   - day1_body
   - followup_subject
   - followup_body
   - cta
3. Add 4 tracking columns in your tool/sheet:
   - `sent_at`
   - `reply_status` (`none`, `positive`, `neutral`, `negative`)
   - `meeting_booked` (`yes/no`)
   - `next_action_date`

### 2) Send first 10 (60-90 min)

1. Prioritize Tier 1 and top Tier 2 targets.
2. Personalize each email with:
   - buyer name
   - one org-specific “why now” line
   - two calendar options for the 20-minute review
3. Send exactly 10 Day 1 emails.
4. Record `sent_at` and set `next_action_date = sent_at + 72h`.

### 3) Same-day response handling (throughout day)

- **Positive reply:**
  1. Offer 2 time slots within 5 business days.
  2. Confirm attendees (clinical + IT/compliance ideally).
  3. Send short prep note and attach `11_` healthcare executive summary (or equivalent approved leave-behind).
- **Neutral / “not now”:**
  1. Acknowledge.
  2. Ask permission for a 30-day recontact.
  3. Keep in sequence unless explicitly opted out.
- **Negative / no fit:**
  1. Mark as closed-lost with reason.
  2. Do not re-sequence.

### 4) End-of-day close (15 min)

1. Count sent, replies, meetings booked.
2. Confirm all 10 have follow-up task at +72h.
3. Update top-level sprint tracker:
   - `Day 1 sent:`
   - `Replies:`
   - `Meetings booked:`
   - `Conversion to meeting:`

---

## Demo-to-pilot conversion path

When a meeting is booked:

1. Run 20-minute technical risk review + short demo path from `02_`.
2. Close call with fixed pilot offer:
   - scope and tier recommendation
   - start window
   - success metrics commitment
3. Send within 2 hours post-call:
   - `15_` SOW
   - `16_` Order Form
   - `17_` Success Metrics

---

## Day 1 success criteria

- [ ] 10 targeted emails sent
- [ ] 100% of sends logged with timestamp
- [ ] 100% of sends scheduled for 72-hour follow-up
- [ ] At least 1 positive reply target on Day 1
- [ ] At least 1 meeting-in-progress by Day 2

---

## Operator notes

- Keep tone clinical/compliance-first; avoid “AI hype” language.
- Prioritize clarity over volume; quality of first 10 matters more than broad blast.
- Do not send SOW/order docs cold in first email; use them after interest is confirmed.
