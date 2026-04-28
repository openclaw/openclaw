import SwiftUI

enum HandoffSource: Equatable {
    case watch
    case deepLink

    var label: String {
        switch self {
        case .watch:
            return "Apple Watch"
        case .deepLink:
            return "Deep Link"
        }
    }
}

enum AppRoute: Equatable {
    case home
    case jobReport(id: String)

    var title: String {
        switch self {
        case .home:
            return "Home"
        case .jobReport(let id):
            return "Job \(id) report"
        }
    }
}

struct ContinuationSectionPreview: Equatable, Identifiable {
    let id: String
    let title: String
    let eyebrow: String
    let icon: String
    let content: String
}

struct ContinuationDetails: Equatable {
    let summaryText: String?
    let transcript: String?
    let phoneReport: String?
    let category: String?
    let nextAction: String?
    let previewSections: [PreviewSectionPayload]?

    func cleaned(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private func shortened(_ value: String?, fallback: String, limit: Int = 120) -> String {
        guard let cleaned = cleaned(value) else { return fallback }
        guard cleaned.count > limit else { return cleaned }
        let prefix = String(cleaned.prefix(limit)).trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(prefix)…"
    }

    var transcriptStatus: String {
        cleaned(transcript) != nil ? "Transcript captured on watch" : "Transcript unavailable"
    }

    var transcriptPreview: String {
        shortened(transcript, fallback: "The watch did not capture a usable transcript.")
    }

    var summaryPreview: String {
        shortened(summaryText, fallback: "The watch did not send a short summary.")
    }

    var handoffReason: String {
        if cleaned(transcript) == nil {
            return "It moved here because the watch could not capture enough command detail on its own."
        }

        if let phoneReport = cleaned(phoneReport), let summary = cleaned(summaryText), phoneReport != summary {
            return "It moved here because the watch only showed the short version, and the fuller report needs the phone screen."
        }

        if cleaned(phoneReport) != nil {
            return "It moved here so you can see the fuller report and continue from the phone."
        }

        return "It moved here because this job needs more room than the watch summary allows."
    }

    var sectionPreviews: [ContinuationSectionPreview] {
        if let previewSections, !previewSections.isEmpty {
            return previewSections.map { section in
                section.continuationPreview { content in
                    shortened(content, fallback: content, limit: 100)
                }
            }
        }

        var items: [ContinuationSectionPreview] = []

        if let category = cleaned(category) {
            items.append(ContinuationSectionPreview(id: "category", title: "Category", eyebrow: "META", icon: "tag", content: shortened(category, fallback: category, limit: 80)))
        }

        items.append(
            ContinuationSectionPreview(
                id: "watch-summary",
                title: "Watch summary",
                eyebrow: "WATCH",
                icon: "applewatch",
                content: summaryPreview
            )
        )

        if let nextAction = cleaned(nextAction) {
            items.append(ContinuationSectionPreview(id: "next-action", title: "Next action", eyebrow: "NEXT", icon: "arrow.forward.circle", content: shortened(nextAction, fallback: nextAction, limit: 100)))
        } else if let phoneReport = cleaned(phoneReport) {
            items.append(ContinuationSectionPreview(id: "phone-detail", title: "Phone detail", eyebrow: "IPHONE", icon: "iphone", content: shortened(phoneReport, fallback: phoneReport, limit: 100)))
        }

        return items
    }

    var highlights: [String] {
        [transcriptStatus] + sectionPreviews.map { "\($0.title): \($0.content)" }
    }
}

struct ContinuationContext: Equatable {
    let route: AppRoute
    let source: HandoffSource
    let details: ContinuationDetails?

    var title: String {
        route.title
    }

    var subtitle: String {
        switch route {
        case .home:
            return "Ready to continue in the companion app."
        case .jobReport(let id):
            return "The watch prepared Job \(id)'s report for a bigger screen."
        }
    }

    var badgeText: String {
        switch source {
        case .watch:
            return "Pending from Apple Watch"
        case .deepLink:
            return "Pending from Deep Link"
        }
    }

    var highlights: [String] {
        details?.highlights ?? []
    }

    var sectionPreviews: [ContinuationSectionPreview] {
        details?.sectionPreviews ?? []
    }
}

@MainActor
final class AppRouter: ObservableObject {
    static let shared = AppRouter()

    @Published var currentRoute: AppRoute = .home
    @Published var pendingRoute: AppRoute?
    @Published var pendingSource: HandoffSource?
    @Published var pendingDetails: ContinuationDetails?
    @Published var lastContinuation: ContinuationContext?

    var pendingContinuation: ContinuationContext? {
        guard let pendingRoute, let pendingSource else { return nil }
        return ContinuationContext(route: pendingRoute, source: pendingSource, details: pendingDetails)
    }

    func open(url: URL, source: HandoffSource = .deepLink, presentImmediately: Bool, details: ContinuationDetails? = nil) -> Bool {
        guard let route = Self.route(for: url) else {
            print("Invalid or unrecognized deep link: \(url.absoluteString)")
            return false
        }

        let continuation = ContinuationContext(route: route, source: source, details: details)
        lastContinuation = continuation

        if presentImmediately {
            currentRoute = route
            pendingRoute = nil
            pendingSource = nil
            pendingDetails = nil
        } else {
            pendingRoute = route
            pendingSource = source
            pendingDetails = details
        }
        return true
    }

    func activatePendingRouteIfNeeded() {
        guard let pendingContinuation else { return }
        currentRoute = pendingContinuation.route
        pendingRoute = nil
        pendingSource = nil
        pendingDetails = nil
        lastContinuation = pendingContinuation
    }

    func reopenLastContinuation() {
        guard let lastContinuation else { return }
        currentRoute = lastContinuation.route
    }

    func dismissToHome() {
        currentRoute = .home
    }

    static func route(for url: URL) -> AppRoute? {
        // Canonical format: ceviz://job/<id>
        // Legacy format still accepted: ceviz://job/<id>/report
        guard url.scheme == "ceviz",
              url.host == "job" else {
            return nil
        }

        if url.pathComponents.count == 2 {
            return .jobReport(id: url.pathComponents[1])
        }

        if url.pathComponents.count == 3, url.pathComponents[2] == "report" {
            return .jobReport(id: url.pathComponents[1])
        }

        return nil
    }
}

@main
struct CompanionApp: App {
    @StateObject private var router = AppRouter.shared

    init() {
        // Ensure the bridge coordinator starts immediately
        _ = WatchBridgeCoordinator.shared
    }

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                Group {
                    switch router.currentRoute {
                    case .home:
                        HomeView(router: router)
                    case .jobReport(let id):
                        JobDetailView(jobId: id, router: router, onClose: router.dismissToHome)
                    }
                }
                .onOpenURL { url in
                    _ = router.open(url: url, source: .deepLink, presentImmediately: true)
                }
            }
        }
    }
}

struct HomeView: View {
    @ObservedObject var router: AppRouter

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "applewatch.side.right")
                .resizable()
                .scaledToFit()
                .frame(width: 80, height: 80)
                .foregroundColor(.blue)

            Text("Ceviz Companion")
                .font(.largeTitle)
                .fontWeight(.bold)

            if let pendingContinuation = router.pendingContinuation {
                ContinuationCard(
                    eyebrow: pendingContinuation.badgeText,
                    title: pendingContinuation.title,
                    subtitle: pendingContinuation.subtitle,
                    highlights: pendingContinuation.highlights,
                    sectionPreviews: pendingContinuation.sectionPreviews,
                    buttonTitle: "Resume on iPhone",
                    action: router.activatePendingRouteIfNeeded
                )
            } else if let lastContinuation = router.lastContinuation {
                ContinuationCard(
                    eyebrow: "Last continuation",
                    title: lastContinuation.title,
                    subtitle: lastContinuation.subtitle,
                    highlights: lastContinuation.highlights,
                    sectionPreviews: lastContinuation.sectionPreviews,
                    buttonTitle: "Open again",
                    accentColor: .orange,
                    action: router.reopenLastContinuation
                )
            } else {
                Text("Waiting for Watch Connectivity or incoming handoff deep links...")
                    .multilineTextAlignment(.center)
                    .foregroundColor(.secondary)
                    .padding(.horizontal)
            }
        }
        .padding()
        .navigationTitle("Home")
    }
}

struct ContinuationCard: View {
    let eyebrow: String
    let title: String
    let subtitle: String
    var highlights: [String] = []
    var sectionPreviews: [ContinuationSectionPreview] = []
    let buttonTitle: String
    var accentColor: Color = .blue
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(eyebrow.uppercased())
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(accentColor)

            Text(title)
                .font(.headline)

            Text(subtitle)
                .font(.subheadline)
                .foregroundColor(.secondary)

            if !sectionPreviews.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(sectionPreviews.prefix(3)) { section in
                        VStack(alignment: .leading, spacing: 4) {
                            Label(section.title, systemImage: section.icon)
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundColor(.primary)

                            Text(section.content)
                                .font(.caption)
                                .foregroundColor(.secondary)
                                .lineLimit(2)
                        }
                        .padding(10)
                        .background(Color.white.opacity(0.82), in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            } else if !highlights.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(highlights.prefix(3).enumerated()), id: \.offset) { _, highlight in
                        Label(highlight, systemImage: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
            }

            Button(buttonTitle, action: action)
                .buttonStyle(.borderedProminent)
                .tint(accentColor)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
        .padding(.horizontal)
    }
}

struct ReportContinuationCard: View {
    let eyebrow: String
    let title: String
    let transcript: String
    let handoffReason: String
    let sectionPreviews: [ContinuationSectionPreview]
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(eyebrow.uppercased())
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundColor(.green)

                    Text(title)
                        .font(.headline)

                    Text("The phone report below is built from this watch capture.")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }

                Spacer()

                Image(systemName: "applewatch.and.arrow.forward")
                    .font(.title3)
                    .foregroundColor(.green)
                    .padding(10)
                    .background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            }

            VStack(spacing: 10) {
                continuationSection(label: "Watch transcript", value: transcript, icon: "waveform.badge.mic")

                ForEach(sectionPreviews.prefix(3)) { section in
                    continuationSection(
                        label: "\(section.eyebrow) • \(section.title)",
                        value: section.content,
                        icon: section.icon
                    )
                }

                continuationSection(label: "Why this moved to iPhone", value: handoffReason, icon: "iphone")
            }

            Button("Back to Home", action: action)
                .buttonStyle(.borderedProminent)
                .tint(.green)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder
    private func continuationSection(label: String, value: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(label, systemImage: icon)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)

            Text(value)
                .font(.subheadline)
                .foregroundColor(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(Color.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct ReportBridgeSection: View {
    let watchSummary: String
    let transcriptStatus: String
    let reportTitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("FROM WATCH TO IPHONE")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.blue)

            Text("How the watch input turns into the full report")
                .font(.headline)

            HStack(alignment: .center, spacing: 10) {
                bridgeColumn(
                    title: "Watch input",
                    body: watchSummary,
                    caption: transcriptStatus,
                    icon: "applewatch"
                )

                Image(systemName: "arrow.forward")
                    .foregroundColor(.blue)
                    .padding(.top, 6)

                bridgeColumn(
                    title: "Expanded on iPhone",
                    body: reportTitle,
                    caption: "The detailed report body below is the longer version of this watch summary.",
                    icon: "iphone"
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
    }

    private func bridgeColumn(title: String, body: String, caption: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: icon)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)

            Text(body)
                .font(.subheadline)
                .foregroundColor(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(caption)
                .font(.caption)
                .foregroundColor(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.white.opacity(0.75), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct JobReportResponse: Codable {
    let jobId: String
    let status: String
    let reportTitle: String
    let reportContent: String
    let reportSections: [ReportBodySectionPayload]?
    let previewSections: [PreviewSectionPayload]?
    let watchSummary: String?
    let requiresPhoneHandoff: Bool?
    let deepLink: String?
    let handoffReason: String?
    let nextAction: String?
    let nextActions: [NextActionPayload]?
    let reportMeta: ReportMeta?
    
    enum CodingKeys: String, CodingKey {
        case jobId = "job_id"
        case status
        case reportTitle = "report_title"
        case reportContent = "report_content"
        case reportSections = "report_sections"
        case previewSections = "preview_sections"
        case watchSummary = "watch_summary"
        case requiresPhoneHandoff = "requires_phone_handoff"
        case deepLink = "deep_link"
        case handoffReason = "handoff_reason"
        case nextAction = "next_action"
        case nextActions = "next_actions"
        case reportMeta = "report_meta"
    }
}

struct ReportBodySection: Identifiable {
    let id: String
    let title: String
    let eyebrow: String
    let icon: String
    let content: String
}

private extension StructuredSectionPayload {
    func continuationPreview(shorten: (String) -> String) -> ContinuationSectionPreview {
        ContinuationSectionPreview(
            id: id,
            title: title,
            eyebrow: eyebrow,
            icon: icon,
            content: shorten(content)
        )
    }

    var reportBodySection: ReportBodySection {
        ReportBodySection(
            id: id,
            title: title,
            eyebrow: eyebrow,
            icon: icon,
            content: content
        )
    }
}

struct ReportBodySectionBuilder {
    let report: JobReportResponse
    let watchSummary: String?

    private func cleaned(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var cleanedWatchSummary: String? {
        cleaned(report.reportMeta?.watchSummary) ?? cleaned(watchSummary)
    }

    private var cleanedCategory: String? {
        cleaned(report.reportMeta?.category)
    }

    private var normalizedBlocks: [String] {
        report.reportContent
            .components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private var analysisContent: String {
        let detailBlock = normalizedBlocks.first { block in
            block.hasPrefix("İşlem Sonucu:") || block.hasPrefix("Detay:")
        }

        if let detailBlock {
            return detailBlock
                .replacingOccurrences(of: "İşlem Sonucu:\n", with: "")
                .replacingOccurrences(of: "Detay:\n", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }

        if normalizedBlocks.count > 1 {
            return normalizedBlocks.dropFirst().joined(separator: "\n\n")
        }

        return report.reportContent.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var nextActionContent: String {
        if let backendNextAction = cleaned(report.reportMeta?.nextAction) ?? cleaned(report.nextAction) {
            return backendNextAction
        }

        switch report.status {
        case "running":
            return "Refresh this screen in a moment to pull the latest OpenClaw progress and updated report body."
        case "failed":
            return "Review the error details above, then retry from the watch or rephrase the command with a clearer capture."
        default:
            if cleanedWatchSummary != nil {
                return "Use the watch summary as the quick takeaway, then act from the expanded analysis above on the phone where there is more room."
            }
            return "Use the expanded analysis above as the full result, then continue on the phone if you need follow-up actions."
        }
    }

    var sections: [ReportBodySection] {
        if let payloadSections = report.reportSections, !payloadSections.isEmpty {
            var items: [ReportBodySection] = []

            if let cleanedCategory {
                items.append(
                    ReportBodySection(
                        id: "category",
                        title: "Category",
                        eyebrow: "META",
                        icon: "tag",
                        content: cleanedCategory
                    )
                )
            }

            items.append(contentsOf: payloadSections.map(\.reportBodySection))
            return items
        }

        var items: [ReportBodySection] = []

        if let cleanedCategory {
            items.append(
                ReportBodySection(
                    id: "category",
                    title: "Category",
                    eyebrow: "META",
                    icon: "tag",
                    content: cleanedCategory
                )
            )
        }

        if let cleanedWatchSummary {
            items.append(
                ReportBodySection(
                    id: "watch-summary",
                    title: "From watch summary",
                    eyebrow: "SOURCE",
                    icon: "applewatch",
                    content: cleanedWatchSummary
                )
            )
        }

        items.append(
            ReportBodySection(
                id: "expanded-analysis",
                title: "Expanded analysis",
                eyebrow: "IPHONE DETAIL",
                icon: "text.alignleft",
                content: analysisContent
            )
        )

        items.append(
            ReportBodySection(
                id: "suggested-next-action",
                title: "Suggested next action",
                eyebrow: "NEXT",
                icon: "arrow.forward.circle",
                content: nextActionContent
            )
        )

        return items
    }
}

struct ReportBodySectionCard: View {
    let section: ReportBodySection

    private var isCodeOrLog: Bool {
        let upperId = section.id.uppercased()
        let upperEyebrow = section.eyebrow.uppercased()
        return upperId.contains("CODE") || upperId.contains("LOG") || upperEyebrow.contains("CODE") || upperEyebrow.contains("LOG") || section.icon == "terminal" || section.icon == "curlybraces"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(section.title, systemImage: section.icon)
                .font(.headline)

            Text(section.eyebrow)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)

            if isCodeOrLog {
                ScrollView(.horizontal, showsIndicators: true) {
                    Text(section.content)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundColor(.primary)
                        .padding(10)
                }
                .background(Color.black.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
            } else {
                Text(section.content)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.white.opacity(0.78), in: RoundedRectangle(cornerRadius: 14))
    }
}

struct ReportDerivedContextSection: View {
    let watchSummary: String
    let transcriptStatus: String

    private var transcriptChipTitle: String {
        transcriptStatus == "Transcript captured on watch" ? "Watch transcript" : "No transcript"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("DERIVED FROM WATCH")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.orange)

            Text("Why this body exists")
                .font(.headline)

            HStack(spacing: 8) {
                derivedChip(title: transcriptChipTitle, systemImage: "applewatch")
                derivedChip(title: "Watch summary", systemImage: "text.quote")
                derivedChip(title: "Expanded on iPhone", systemImage: "iphone")
            }

            VStack(alignment: .leading, spacing: 10) {
                derivedDetailRow(
                    label: "Source summary",
                    value: watchSummary,
                    icon: "text.append"
                )

                derivedDetailRow(
                    label: "This report body adds",
                    value: "More room, structure, and readable detail than the watch summary could show on its own.",
                    icon: "arrow.up.left.and.arrow.down.right"
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
    }

    private func derivedChip(title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(.caption)
            .fontWeight(.semibold)
            .foregroundColor(.orange)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.white.opacity(0.9), in: Capsule())
    }

    private func derivedDetailRow(label: String, value: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(label, systemImage: icon)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)

            Text(value)
                .font(.subheadline)
                .foregroundColor(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.white.opacity(0.78), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct ReportMetaHeaderCard: View {
    let report: JobReportResponse

    private var titleText: String {
        report.reportMeta?.title ?? report.reportTitle
    }

    private var statusText: String? {
        report.reportMeta?.status ?? report.status
    }

    private var severityText: String? {
        report.reportMeta?.severity
    }

    private var handoffReasonText: String? {
        report.reportMeta?.handoffReason ?? report.handoffReason
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(titleText)
                .font(.title2)
                .fontWeight(.bold)

            HStack(spacing: 8) {
                if let statusText {
                    metaChip(statusText.capitalized, systemImage: "circle.fill")
                }
                if let severityText {
                    metaChip("Severity: \(severityText.capitalized)", systemImage: "exclamationmark.shield")
                }
                if let category = report.reportMeta?.category {
                    metaChip(category, systemImage: "tag")
                }
            }

            if let handoffReasonText, !handoffReasonText.isEmpty {
                Label(handoffReasonText.replacingOccurrences(of: "_", with: " ").capitalized, systemImage: "iphone.and.arrow.forward")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.white.opacity(0.8), in: RoundedRectangle(cornerRadius: 14))
    }

    private func metaChip(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.caption)
            .fontWeight(.semibold)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.blue.opacity(0.08), in: Capsule())
    }
}

struct NextActionsCard: View {
    let actions: [NextActionPayload]
    @ObservedObject var router: AppRouter
    @State private var showHint: Bool = false
    @State private var hintMessage: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Next actions")
                .font(.headline)

            ForEach(actions) { action in
                if action.kind == "hint" {
                    actionRow(for: action)
                } else {
                    Button(action: {
                        handleAction(action)
                    }) {
                        actionRow(for: action)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
        .alert(isPresented: $showHint) {
            Alert(title: Text("Action Info"), message: Text(hintMessage), dismissButton: .default(Text("OK")))
        }
    }

    private func actionRow(for action: NextActionPayload) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(action.label)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(.primary)

                Text(action.kind.capitalized)
                    .font(.caption)
                    .foregroundColor(.secondary)

                if let target = action.target, !target.isEmpty {
                    Text(target)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer()
            Image(systemName: iconForKind(action.kind))
                .foregroundColor(action.kind == "hint" ? .secondary : .blue)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 12))
    }

    private func handleAction(_ action: NextActionPayload) {
        if action.kind == "deep_link" || action.kind == "deeplink" {
            if let target = action.target, let url = URL(string: target) {
                _ = router.open(url: url, source: .deepLink, presentImmediately: true)
            } else {
                hintMessage = "Invalid Deep Link: \(action.target ?? "N/A")"
                showHint = true
            }
        } else if action.kind == "open_url" {
            if let target = action.target, let url = URL(string: target) {
                UIApplication.shared.open(url)
            } else {
                hintMessage = "Invalid URL: \(action.target ?? "N/A")"
                showHint = true
            }
        } else if action.kind == "copy" {
            if let target = action.target, !target.isEmpty {
                UIPasteboard.general.string = target
                hintMessage = "Copied to clipboard:\n\(target)"
                showHint = true
            } else {
                hintMessage = "Nothing to copy (target is empty or missing)"
                showHint = true
            }
        } else if action.kind == "api_call" {
            performApiCall(action)
        } else {
            hintMessage = "Triggered: \(action.label)\nKind: \(action.kind)\nTarget: \(action.target ?? "N/A")"
            showHint = true
        }
    }

    private func performApiCall(_ action: NextActionPayload) {
        guard let target = action.target, !target.isEmpty else {
            hintMessage = "Missing API target for action: \(action.label)"
            showHint = true
            return
        }

        guard let url = resolvedApiCallURL(from: target) else {
            hintMessage = "Invalid API target: \(target)"
            showHint = true
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        Task {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200...299).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }

                let payload = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]

                await MainActor.run {
                    if let deepLinkValue = payload["deep_link"] as? String,
                       let url = URL(string: deepLinkValue) {
                        _ = router.open(url: url, source: .deepLink, presentImmediately: true)
                    }

                    if let error = payload["error"] as? String, !error.isEmpty {
                        hintMessage = error
                        showHint = true
                        return
                    }

                    if let summary = payload["summary"] as? String, !summary.isEmpty {
                        hintMessage = summary
                        showHint = true
                        return
                    }

                    if let status = payload["status"] as? String, !status.isEmpty {
                        hintMessage = "Action completed: \(status.capitalized)"
                        showHint = true
                        return
                    }

                    hintMessage = "Action completed: \(action.label)"
                    showHint = true
                }
            } catch {
                await MainActor.run {
                    hintMessage = "API action failed: \(error.localizedDescription)"
                    showHint = true
                }
            }
        }
    }

    private func resolvedApiCallURL(from target: String) -> URL? {
        if target.hasPrefix("http://") || target.hasPrefix("https://") {
            return URL(string: target)
        }

        if target.hasPrefix("/") {
            return URL(string: "http://127.0.0.1:8080\(target)")
        }

        return URL(string: target)
    }

    private func iconForKind(_ kind: String) -> String {
        switch kind {
        case "deep_link", "deeplink": return "link"
        case "open_url": return "safari"
        case "api_call": return "bolt.fill"
        case "hint": return "lightbulb.fill"
        case "copy": return "doc.on.doc.fill"
        default: return "arrow.forward.circle.fill"
        }
    }
}

struct JobDetailView: View {
    let jobId: String
    @ObservedObject var router: AppRouter
    let onClose: () -> Void
    
    // Fetch Data State
    @State private var isLoading: Bool = true
    @State private var errorMessage: String?
    @State private var report: JobReportResponse?

    private var activeContinuation: ContinuationContext? {
        guard let lastContinuation = router.lastContinuation else { return nil }
        guard lastContinuation.route == .jobReport(id: jobId) else { return nil }
        return lastContinuation
    }

    private var continuationDetailsForCard: ContinuationDetails? {
        if let details = activeContinuation?.details {
            return details
        }

        guard let report,
              report.reportMeta?.requiresPhoneHandoff == true || report.requiresPhoneHandoff == true || report.reportMeta?.watchSummary != nil || report.watchSummary != nil else {
            return nil
        }

        return ContinuationDetails(
            summaryText: report.reportMeta?.watchSummary ?? report.watchSummary,
            transcript: nil,
            phoneReport: report.reportMeta?.phoneReport ?? report.reportContent,
            category: report.reportMeta?.category,
            nextAction: report.reportMeta?.nextAction ?? report.nextAction,
            previewSections: report.previewSections
        )
    }

    private var bridgeSummaryText: String? {
        guard let details = continuationDetailsForCard else { return nil }
        return details.cleaned(report?.watchSummary) ?? details.cleaned(details.summaryText)
    }

    private var reportBodySections: [ReportBodySection] {
        guard let report else { return [] }
        return ReportBodySectionBuilder(report: report, watchSummary: bridgeSummaryText).sections
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let details = continuationDetailsForCard {
                ReportContinuationCard(
                    eyebrow: activeContinuation?.source == .watch ? "Continued from Apple Watch" : "Prepared for iPhone",
                    title: activeContinuation?.title ?? "Job \(jobId) report",
                    transcript: details.transcriptPreview,
                    handoffReason: details.handoffReason,
                    sectionPreviews: details.sectionPreviews,
                    action: onClose
                )
                .padding(.top, 4)
            }

            if let report, let watchSummary = bridgeSummaryText, let details = continuationDetailsForCard {
                ReportBridgeSection(
                    watchSummary: watchSummary,
                    transcriptStatus: details.transcriptStatus,
                    reportTitle: report.reportTitle
                )
            }

            if isLoading {
                ProgressView("Fetching report for \(jobId)...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = errorMessage {
                Text("Error: \(error)")
                    .foregroundColor(.red)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let report = report {
                VStack(alignment: .leading, spacing: 6) {
                    if bridgeSummaryText != nil {
                        Label("Expanded from watch summary", systemImage: "applewatch.and.arrow.forward")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundColor(.blue)
                    } else {
                        Text("Full report")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundColor(.secondary)
                    }

                    Text(report.reportTitle)
                        .font(.title)
                        .fontWeight(.bold)

                    if activeContinuation != nil || report.reportMeta?.requiresPhoneHandoff == true || report.requiresPhoneHandoff == true || report.reportMeta?.watchSummary != nil || report.watchSummary != nil {
                        Text("Expanded on iPhone from the watch capture and summary above.")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                }

                Divider()

                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ReportMetaHeaderCard(report: report)

                        Text(bridgeSummaryText != nil ? "Expanded report body" : "Report body")
                            .font(.headline)

                        if let watchSummary = bridgeSummaryText, let details = continuationDetailsForCard {
                            ReportDerivedContextSection(
                                watchSummary: watchSummary,
                                transcriptStatus: details.transcriptStatus
                            )

                            Label("This report is now split into source-aware sections so the watch summary, fuller analysis, and next action read as separate layers.", systemImage: "square.split.2x2")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }

                        ForEach(reportBodySections) { section in
                            ReportBodySectionCard(section: section)
                        }

                        if let nextActions = report.nextActions, !nextActions.isEmpty {
                            NextActionsCard(actions: nextActions, router: router)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            Spacer()
        }
        .padding()
        .navigationTitle("Job Report")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                HStack(spacing: 16) {
                    Button(action: {
                        isLoading = true
                        fetchReport()
                    }) {
                        Image(systemName: "arrow.clockwise")
                    }
                    Button("Close", action: onClose)
                }
            }
        }
        .onAppear {
            fetchReport()
        }
    }
    
    private func fetchReport() {
        guard let url = URL(string: "http://172.17.169.202:8080/api/v1/jobs/\(jobId)/report") else {
            self.errorMessage = "Invalid URL"
            self.isLoading = false
            return
        }
        
        URLSession.shared.dataTask(with: url) { data, response, error in
            DispatchQueue.main.async {
                self.isLoading = false
                if let error = error {
                    self.errorMessage = error.localizedDescription
                    return
                }
                
                guard let data = data else {
                    self.errorMessage = "No data received"
                    return
                }
                
                do {
                    let decoder = JSONDecoder()
                    self.report = try decoder.decode(JobReportResponse.self, from: data)
                    if let report = self.report, self.activeContinuation?.details == nil {
                        let source = self.activeContinuation?.source ?? .watch
                        let url = URL(string: report.deepLink ?? "ceviz://job/\(self.jobId)")!
                        _ = self.router.open(
                            url: url,
                            source: source,
                            presentImmediately: true,
                            details: ContinuationDetails(
                                summaryText: report.reportMeta?.watchSummary ?? report.watchSummary,
                                transcript: nil,
                                phoneReport: report.reportMeta?.phoneReport ?? report.reportContent,
                                category: report.reportMeta?.category,
                                nextAction: report.reportMeta?.nextAction ?? report.nextAction,
                                previewSections: nil
                            )
                        )
                    }
                } catch {
                    self.errorMessage = "Decoding error: \(error.localizedDescription)"
                }
            }
        }.resume()
    }
}
