import SwiftUI

struct JobsListView: View {
    @ObservedObject var sessionManager: WatchSessionManager
    
    var body: some View {
        List {
            if sessionManager.activeJobs.isEmpty {
                Text("No active jobs")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .padding()
            } else {
                ForEach(sessionManager.activeJobs) { job in
                    NavigationLink(destination: JobDetailView(job: job, sessionManager: sessionManager)) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(job.name)
                                .font(.headline)
                                .lineLimit(2)
                            
                            HStack {
                                statusIcon(for: job.status)
                                Text(job.status.capitalized)
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                                Spacer()
                                Text("\(job.elapsedSeconds)s")
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }

                            Text(job.summaryText)
                                .font(.caption2)
                                .foregroundColor(.secondary)
                                .lineLimit(2)

                            if job.continuationPreview != nil {
                                JobContinuationBadge(preview: job.continuationPreview, compact: true)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
        .navigationTitle("Jobs")
        .onAppear {
            sessionManager.fetchJobs()
        }
    }
    
    @ViewBuilder
    private func statusIcon(for status: String) -> some View {
        switch status {
        case "running":
            Image(systemName: "arrow.triangle.2.circlepath")
                .foregroundColor(.blue)
        case "completed":
            Image(systemName: "checkmark.circle.fill")
                .foregroundColor(.green)
        case "failed":
            Image(systemName: "xmark.octagon.fill")
                .foregroundColor(.red)
        case "queued":
            Image(systemName: "clock.fill")
                .foregroundColor(.orange)
        default:
            Image(systemName: "questionmark.circle")
                .foregroundColor(.gray)
        }
    }
}

struct JobContinuationBadge: View {
    let preview: HandoffPreview?
    var compact: Bool = false

    var body: some View {
        HandoffSectionContainer(title: "More on iPhone", systemImage: "iphone", compact: compact) {
            if let firstSection = preview?.sectionSnippets.first {
                HandoffSectionCard(section: firstSection, lineLimit: compact ? 1 : 2, compact: true)
            } else {
                HandoffMessageCard(
                    eyebrow: "IPHONE",
                    title: "Continuation ready",
                    systemImage: "arrow.triangle.branch",
                    message: "Open the full report on phone.",
                    lineLimit: 2,
                    compact: true
                )
            }
        }
    }
}
