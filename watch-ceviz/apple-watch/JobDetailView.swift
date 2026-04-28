import SwiftUI

struct JobDetailView: View {
    let job: ActiveJob
    @ObservedObject var sessionManager: WatchSessionManager
    @State private var actionMessage: String?

    private var activeSessionHandoffMatchesJob: Bool {
        sessionManager.handoffJobId == job.id && sessionManager.handoffUrl != nil
    }

    private var resolvedHandoffUrl: String? {
        if activeSessionHandoffMatchesJob {
            return sessionManager.handoffUrl
        }
        return job.deepLink
    }

    private var handoffSubtitle: String {
        if activeSessionHandoffMatchesJob {
            return sessionManager.handoffSubtitle
        }
        return sessionManager.isReachable ? "Open the fuller phone view shown below." : "iPhone must be reachable first."
    }
    
    private var latestPreview: HandoffPreview? {
        if activeSessionHandoffMatchesJob, sessionManager.handoffPreview != nil {
            return sessionManager.handoffPreview
        }
        return job.continuationPreview
    }

    private var actionButtons: [NextActionPayload] {
        if let nextActions = job.nextActions, !nextActions.isEmpty {
            return nextActions.filter { action in
                action.kind == "api_call"
            }
        }

        var fallback: [NextActionPayload] = [
            NextActionPayload(
                id: "summarize-progress",
                label: "Summarize",
                kind: "api_call",
                target: "/api/v1/jobs/\(job.id)/summarize"
            )
        ]

        if job.status == "running" || job.status == "queued" {
            fallback.append(
                NextActionPayload(
                    id: "cancel-job",
                    label: "Stop Job",
                    kind: "api_call",
                    target: "/api/v1/jobs/\(job.id)/cancel"
                )
            )
        }

        return fallback
    }
    
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(job.name)
                    .font(.headline)
                
                HStack {
                    Text("Status:")
                    Spacer()
                    Text(job.status.capitalized)
                        .foregroundColor(statusColor(for: job.status))
                }
                
                HStack {
                    Text("Elapsed:")
                    Spacer()
                    Text("\(job.elapsedSeconds)s")
                }

                Text(job.summaryText)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let reportSections = job.reportSections, !reportSections.isEmpty { 
                    VStack(alignment: .leading, spacing: 8) { 
                        ForEach(reportSections) { section in 
                            ReportSectionCard(section: section) 
                        } 
                    } 
                } 

                if job.status == "failed" { 
                    VStack(alignment: .leading, spacing: 4) { 
                        HStack { 
                            Image(systemName: "exclamationmark.triangle.fill") 
                                .foregroundColor(.red) 
                            Text("Job Failed") 
                                .font(.caption) 
                                .fontWeight(.bold) 
                                .foregroundColor(.red) 
                        } 
                        
                        if let code = job.reportMeta?.failureCode { 
                            Text("Code: \(code)") 
                                .font(.system(size: 10, weight: .semibold)) 
                        } 
                        
                        if let msg = job.reportMeta?.failureMessage { 
                            Text(msg) 
                                .font(.system(size: 10)) 
                                .foregroundColor(.secondary) 
                                .fixedSize(horizontal: false, vertical: true) 
                        } 
                        
                        if let retries = job.reportMeta?.retryCount, retries > 0 { 
                            Text("Retried \(retries) times") 
                                .font(.system(size: 9)) 
                                .italic() 
                                .foregroundColor(.secondary) 
                        } 
                    } 
                    .padding(8) 
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.1))) 
                }

                if resolvedHandoffUrl != nil,
                   latestPreview != nil {
                    HandoffOpenPanel(
                        buttonTitle: sessionManager.handoffTitle(for: resolvedHandoffUrl),
                        subtitle: handoffSubtitle,
                        preview: latestPreview,
                        isReachable: sessionManager.isReachable,
                        action: {
                            sessionManager.openHandoff(url: resolvedHandoffUrl, jobId: job.id)
                        }
                    )
                } else if latestPreview != nil {
                    JobContinuationBadge(preview: latestPreview)
                }
                
                Divider()
                
                if let msg = actionMessage {
                    Text(msg)
                        .font(.caption)
                        .foregroundColor(.blue)
                        .multilineTextAlignment(.leading)
                        .padding(.vertical, 4)
                }

                ForEach(actionButtons) { action in
                    Button(action: {
                        executeAction(action)
                    }) {
                        Label(action.label, systemImage: iconName(for: action))
                    }
                    .tint(tintColor(for: action))
                }
            }
            .padding()
        }
        .navigationTitle("Details")
    }
    
    private func statusColor(for status: String) -> Color {
        switch status {
        case "running": return .blue
        case "completed": return .green
        case "failed": return .red
        case "queued": return .orange
        default: return .gray
        }
    }

    private func executeAction(_ action: NextActionPayload) {
        // Optimistic update: hemen UI'da değişiklik göster
        let originalStatus = job.status
        actionMessage = progressMessage(for: action)
        
        // Eğer cancel işlemiyse, hemen "cancelling" durumuna geç
        if action.id == "cancel-job" {
            // Burada job'ın durumunu geçici olarak değiştirebiliriz
            // Ancak SwiftUI struct immutable olduğu için sessionManager üzerinden yapmamız gerek
            sessionManager.updateJobStatus(jobId: job.id, newStatus: "cancelling")
        }
        
        sessionManager.performNextAction(action, jobId: job.id) { response in
            DispatchQueue.main.async {
                actionMessage = response
                if response.lowercased().contains("error") || response.lowercased().contains("not reachable") || response.lowercased().contains("unsupported") {
                    WKInterfaceDevice.current().play(.failure)
                    // Error durumunda original status'a dön
                    if action.id == "cancel-job" {
                        sessionManager.updateJobStatus(jobId: job.id, newStatus: originalStatus)
                    }
                } else {
                    WKInterfaceDevice.current().play(.success)
                    // Başarılı işlemde fetchJobs otomatik olarak çağrılacak
                }
            }
        }
    }

    private func progressMessage(for action: NextActionPayload) -> String {
        switch action.id {
        case "cancel-job":
            return "Cancelling..."
        case "summarize-progress":
            return "Summarizing..."
        default:
            return "Working..."
        }
    }

    private func tintColor(for action: NextActionPayload) -> Color {
        action.id == "cancel-job" ? .red : .blue
    }

    private func iconName(for action: NextActionPayload) -> String {
        switch action.id {
        case "cancel-job":
            return "xmark.circle.fill"
        case "summarize-progress":
            return "doc.text.magnifyingglass"
        default:
            return "bolt.fill"
        }
    }
}
