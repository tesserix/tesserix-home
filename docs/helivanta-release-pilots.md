# Helivanta release pilot controls

The Helivanta release catalogue is read from its deployed `release/prod` contract.
An entry with `eligible: false, pilot_eligible: true` is not generally released.
Console treats it as editable within a **Pilot only** scope. Its switch changes
only the existing audited GrowthBook Boolean value; it cannot add tenant IDs,
change expiry or override application authorization.

`pilot_only` is an additive API-owner response field. Console accepts older
responses as `false`. An enabled pilot entry displays **Pilot enabled**, not a
claim of all-tenant availability. The application separately requires its
operator-mounted, unexpired tenant policy and authenticated tenant membership.
If that policy is absent or expired, the feature stays blocked even when Console
reports its provider prerequisites as ready.

Follow the [Helivanta scoped-pilot procedure](https://github.com/tesserix/helivanta/blob/main/docs/design/1689-qa-retail-pilot.md).
The procedure defines exact release revisions, approved tenants and deadline,
Global API/UI acceptance, data handling and shutdown. Deploy these compatible
Console changes before activating a Helivanta pilot. An older catalogue remains
supported; this release alone enables no application capability.

Operator authorization, stale-revision checks, dependency review, required reason,
idempotency, audit journal and uncertain-provider-outcome recovery are unchanged.
