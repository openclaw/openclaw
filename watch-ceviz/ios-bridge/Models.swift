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

struct JobSummaryResponse: Codable {
    let summary: String
    let requiresPhoneHandoff: Bool
    let status: String
    let transcript: String
    let phoneReport: String
    let handoffUrl: String?
    let deepLink: String?
    let handoffReason: String?
    let reportMeta: ReportMeta?
    let reportSections: [ReportBodySectionPayload]?
    let previewSections: [PreviewSectionPayload]?
    let nextActions: [NextActionPayload]?

    enum CodingKeys: String, CodingKey {
        case summary
        case requiresPhoneHandoff = "requires_phone_handoff"
        case status
        case transcript
        case phoneReport = "phone_report"
        case handoffUrl = "handoff_url"
        case deepLink = "deep_link"
        case handoffReason = "handoff_reason"
        case reportMeta = "report_meta"
        case reportSections = "report_sections"
        case previewSections = "preview_sections"
        case nextActions = "next_actions"
    }
}

struct StructuredSectionPayload: Codable, Equatable, Identifiable {
    let id: String
    let title: String
    let eyebrow: String
    let icon: String
    let content: String
}

typealias PreviewSectionPayload = StructuredSectionPayload
typealias ReportBodySectionPayload = StructuredSectionPayload

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
}

struct ActiveJobsResponse: Codable {
    let jobs: [ActiveJob]
}
