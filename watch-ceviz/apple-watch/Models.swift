import Foundation

// Mirrors watch-command-request.schema.json
struct WatchCommandRequest: Codable {
    let audioData: String
    let format: String
    let clientTimestamp: String?

    enum CodingKeys: String, CodingKey {
        case audioData = "audio_data"
        case format
        case clientTimestamp = "client_timestamp"
    }
}

struct ReportMeta: Codable, Equatable {
    let title: String?
    let status: String?
    let severity: String?
    let category: String
    let watchSummary: String
    let requiresPhoneHandoff: Bool
    let handoffReason: String?
    let phoneReport: String
    let nextAction: String?
    let retryCount: Int
    let failureCode: String?
    let failureMessage: String?

    enum CodingKeys: String, CodingKey {
        case title
        case status
        case severity
        case category
        case watchSummary = "watch_summary"
        case requiresPhoneHandoff = "requires_phone_handoff"
        case handoffReason = "handoff_reason"
        case phoneReport = "phone_report"
        case nextAction = "next_action"
        case retryCount = "retry_count"
        case failureCode = "failure_code"
        case failureMessage = "failure_message"
    }
}

struct NextActionPayload: Codable, Equatable, Identifiable {
    let id: String
    let label: String
    let kind: String
    let target: String?
}

// Mirrors watch-command-response.schema.json
struct WatchCommandResponse: Codable {
    let status: String
    let transcript: String
    let summaryText: String
    let ttsAudioData: String?
    let ttsFormat: String?
    let requiresPhoneHandoff: Bool
    let handoffUrl: String?
    let deepLink: String?
    let handoffReason: String?
    let jobId: String?
    let phoneReport: String?
    let reportMeta: ReportMeta?
    let reportSections: [ReportBodySectionPayload]?
    let previewSections: [PreviewSectionPayload]?
    let nextActions: [NextActionPayload]?

    enum CodingKeys: String, CodingKey {
        case status
        case transcript
        case summaryText = "summary_text"
        case ttsAudioData = "tts_audio_data"
        case ttsFormat = "tts_format"
        case requiresPhoneHandoff = "requires_phone_handoff"
        case handoffUrl = "handoff_url"
        case deepLink = "deep_link"
        case handoffReason = "handoff_reason"
        case jobId = "job_id"
        case phoneReport = "phone_report"
        case reportMeta = "report_meta"
        case reportSections = "report_sections"
        case previewSections = "preview_sections"
        case nextActions = "next_actions"
    }
}

typealias ReportBodySectionPayload = PreviewSectionPayload

struct PreviewSectionPayload: Codable, Equatable, Identifiable {
    let id: String
    let title: String
    let eyebrow: String
    let icon: String
    let content: String
}

struct HandoffPreviewSection: Equatable, Identifiable {
    let id: String
    let title: String
    let eyebrow: String
    let icon: String
    let content: String
}

struct HandoffPreview: Equatable {
    let transcript: String?
    let summaryText: String?
    let phoneReport: String?
    let category: String?
    let nextAction: String?
    let retryCount: Int
    let failureCode: String?
    let failureMessage: String?
    let reportSections: [ReportBodySectionPayload]?
    let previewSections: [PreviewSectionPayload]?

    private func cleaned(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private func shortened(_ value: String, limit: Int = 100) -> String {
        guard value.count > limit else { return value }
        let prefix = String(value.prefix(limit)).trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(prefix)…"
    }

    private func shortened(_ value: String?, fallback: String, limit: Int = 100) -> String {
        guard let cleaned = cleaned(value) else { return fallback }
        return shortened(cleaned, limit: limit)
    }

    var transcriptStatus: String {
        cleaned(transcript) != nil ? "Transcript captured on watch" : "Transcript unavailable"
    }

    var summaryPreview: String {
        shortened(summaryText, fallback: "The watch did not send a short summary.")
    }

    var sectionSnippets: [HandoffPreviewSection] {
        if let previewSections, !previewSections.isEmpty {
            return previewSections.map {
                HandoffPreviewSection(
                    id: $0.id,
                    title: $0.title,
                    eyebrow: $0.eyebrow,
                    icon: $0.icon,
                    content: shortened($0.content)
                )
            }
        }

        var items: [HandoffPreviewSection] = []

        if let category = cleaned(category) {
            items.append(
                HandoffPreviewSection(
                    id: "category",
                    title: "Category",
                    eyebrow: "META",
                    icon: "tag",
                    content: shortened(category, limit: 60)
                )
            )
        }

        items.append(
            HandoffPreviewSection(
                id: "watch-summary",
                title: "Watch summary",
                eyebrow: "WATCH",
                icon: "applewatch",
                content: summaryPreview
            )
        )

        if let nextAction = cleaned(nextAction) {
            items.append(
                HandoffPreviewSection(
                    id: "next-action",
                    title: "Next action",
                    eyebrow: "NEXT",
                    icon: "arrow.forward.circle",
                    content: shortened(nextAction, limit: 80)
                )
            )
        } else if let phoneReport = cleaned(phoneReport) {
            items.append(
                HandoffPreviewSection(
                    id: "phone-detail",
                    title: "Phone detail",
                    eyebrow: "IPHONE",
                    icon: "iphone",
                    content: shortened(phoneReport, limit: 80)
                )
            )
        }

        if items.isEmpty {
            items.append(
                HandoffPreviewSection(
                    id: "transcript-status",
                    title: "Capture",
                    eyebrow: "WATCH",
                    icon: "waveform.badge.mic",
                    content: transcriptStatus
                )
            )
        }

        return items
    }

    var highlights: [String] {
        [transcriptStatus] + sectionSnippets.map { "\($0.title): \($0.content)" }
    }
}

struct ActiveJob: Codable, Identifiable {
    let id: String
    let name: String
    var status: String
    let elapsedSeconds: Int
    let summaryText: String
    let requiresPhoneHandoff: Bool
    let transcript: String
    let phoneReport: String
    let deepLink: String?
    let reportMeta: ReportMeta?
    let reportSections: [ReportBodySectionPayload]?
    let previewSections: [PreviewSectionPayload]?
    let nextActions: [NextActionPayload]?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case status
        case elapsedSeconds = "elapsed_seconds"
        case summaryText = "summary_text"
        case requiresPhoneHandoff = "requires_phone_handoff"
        case transcript
        case phoneReport = "phone_report"
        case deepLink = "deep_link"
        case reportMeta = "report_meta"
        case reportSections = "report_sections"
        case previewSections = "preview_sections"
        case nextActions = "next_actions"
    }

    var continuationPreview: HandoffPreview? {
        let effectiveRequiresPhoneHandoff = reportMeta?.requiresPhoneHandoff ?? requiresPhoneHandoff
        guard effectiveRequiresPhoneHandoff else { return nil }
        return HandoffPreview(
            transcript: transcript,
            summaryText: reportMeta?.watchSummary ?? summaryText,
            phoneReport: reportMeta?.phoneReport ?? phoneReport,
            category: reportMeta?.category,
            nextAction: reportMeta?.nextAction,
            retryCount: reportMeta?.retryCount ?? 0,
            failureCode: reportMeta?.failureCode,
            failureMessage: reportMeta?.failureMessage,
            reportSections: reportMeta != nil ? reportSections : nil,
            previewSections: previewSections
        )
    }
}

struct ActiveJobsResponse: Codable {
    let jobs: [ActiveJob]
}
