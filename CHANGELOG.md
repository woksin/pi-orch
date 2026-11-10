# Changelog

## Unreleased

### Added
- Write the lanes launch record (`<LANES_DIR>/.state/roster/<PI_ORCH_ID>.json`) when a UI session starts with both `PI_ORCH_ID` and `LANES_DIR` set, and set `retiredAt` on shutdown, so `lanes who` attributes the session. A live record of another process, symlinked state directories and invalid ids are left untouched; `PI_ORCH_OPTOUT=1` also skips it.

## 0.2.0

### Changed
- Batch actionable notices from each inbox scan into one dispatch, steering urgent messages without waiting for another scan.
- Retain informational messages in the durable inbox until the next legitimate run, without periodic digest wakes.
- Notify accountable owners only when heartbeat health incidents change, with silent recovery and conservative handling of uncertain process records.

### Fixed
- Show acknowledgement instructions only for messages that require acknowledgement.
