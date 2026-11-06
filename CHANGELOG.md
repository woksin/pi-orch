# Changelog

## 0.2.0

### Changed
- Batch actionable notices from each inbox scan into one dispatch, steering urgent messages without waiting for another scan.
- Retain informational messages in the durable inbox until the next legitimate run, without periodic digest wakes.
- Notify accountable owners only when heartbeat health incidents change, with silent recovery and conservative handling of uncertain process records.

### Fixed
- Show acknowledgement instructions only for messages that require acknowledgement.
