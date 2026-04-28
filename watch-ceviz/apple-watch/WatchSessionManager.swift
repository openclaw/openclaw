import Foundation
import WatchConnectivity
import Combine
import WatchKit

struct QueuedCommand: Codable, Identifiable { 
    let id: String 
    let audioData: String 
    let timestamp: Date 
    var retryCount: Int 
} 


class WatchSessionManager: NSObject, ObservableObject, WCSessionDelegate, WKExtendedRuntimeSessionDelegate {
    @Published var isReachable = false
    @Published var responseText = "Ready"
    @Published var handoffUrl: String? = nil
    @Published var handoffJobId: String? = nil
    @Published var activeJobs: [ActiveJob] = []
    @Published var pendingCommands: [QueuedCommand] = []
    @Published var transportStatus: String = "Disconnected"
    @Published var handoffState: HandoffState = .idle
    @Published var handoffPreview: HandoffPreview? = nil

    private var extendedSession: WKExtendedRuntimeSession?

    enum HandoffState: Equatable {
        case idle
        case ready
        case pendingOnPhone
        case openedOnPhone
    }

    func startExtendedSession() {
        if extendedSession == nil || extendedSession?.state == .invalid {
            extendedSession = WKExtendedRuntimeSession()
            extendedSession?.delegate = self
            extendedSession?.start()
            print("Extended runtime session started for data transfer.")
        }
    }

    func stopExtendedSession() {
        extendedSession?.invalidate()
        extendedSession = nil
        print("Extended runtime session stopped.")
    }

    // WKExtendedRuntimeSessionDelegate methods
    func extendedRuntimeSession(_ extendedRuntimeSession: WKExtendedRuntimeSession, didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason, error: Error?) {
        print("Extended session invalidated: \(reason)")
        extendedSession = nil
    }

    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        print("Extended session did start")
    }

    func extendedRuntimeSessionWillExpire(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        print("Extended session will expire")
    }

    func handoffTitle(for handoffUrl: String? = nil) -> String {
        guard let url = handoffUrl ?? self.handoffUrl,
              let parsedUrl = URL(string: url),
              let route = parsedUrl.host,
              route == "job",
              parsedUrl.pathComponents.count > 1 else {
            return "Continue on Phone"
        }

        return "Open job \(parsedUrl.pathComponents[1]) on Phone"
    }

    var handoffSubtitle: String {
        switch handoffState {
        case .idle:
            return ""
        case .ready:
            return isReachable ? "Open the fuller phone view shown below." : "iPhone must be reachable first."
        case .pendingOnPhone:
            return "Queued on iPhone. Bring the app to the foreground to continue."
        case .openedOnPhone:
            return "The report is now open on iPhone."
        }
    }
    
    // Add reference to audio player to play tts immediately upon response
    var audioPlayerManager: AudioPlayerManager?

    private func reportMeta(from rawValue: Any?) -> ReportMeta? {
        guard let rawMeta = rawValue as? [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: rawMeta),
              let decoded = try? JSONDecoder().decode(ReportMeta.self, from: data) else {
            return nil
        }
        return decoded
    }

    private func previewSections(from rawValue: Any?) -> [PreviewSectionPayload]? {
        guard let rawSections = rawValue as? [[String: Any]],
              let data = try? JSONSerialization.data(withJSONObject: rawSections),
              let decoded = try? JSONDecoder().decode([PreviewSectionPayload].self, from: data),
              !decoded.isEmpty else {
            return nil
        }
        return decoded
    }
    
    private func reportSections(from rawValue: Any?) -> [ReportBodySectionPayload]? {
        guard let rawSections = rawValue as? [[String: Any]],
              let data = try? JSONSerialization.data(withJSONObject: rawSections),
              let decoded = try? JSONDecoder().decode([ReportBodySectionPayload].self, from: data),
              !decoded.isEmpty else {
            return nil
        }
        return decoded
    }

    override init() {
        super.init()
        if WCSession.isSupported() {
            let session = WCSession.default
            session.delegate = self
            session.activate()
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.isReachable = session.isReachable
            self.updateTransportStatus(session)
            if session.isReachable { self.processQueue() }
        }
    }

    private func updateTransportStatus(_ session: WCSession) { 
        let stateText: String 
        switch session.activationState { 
        case .notActivated: stateText = "Not Activated" 
        case .inactive: stateText = "Inactive" 
        case .activated: stateText = session.isReachable ? "Connected" : "Reconnecting..." 
        @unknown default: stateText = "Unknown" 
        } 
        DispatchQueue.main.async { 
            self.transportStatus = stateText 
        } 
    } 

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.isReachable = session.isReachable
            self.updateTransportStatus(session)
            if session.isReachable { self.processQueue() }
        }
    }

    func fetchJobs() {
        guard WCSession.default.isReachable else {
            print("Cannot fetch jobs: Session not reachable")
            return
        }
        
        WCSession.default.sendMessage(["action": "fetch_jobs"], replyHandler: { reply in
            if let jobsData = reply["jobs"] as? [[String: Any]] {
                do {
                    let data = try JSONSerialization.data(withJSONObject: jobsData)
                    let decodedJobs = try JSONDecoder().decode([ActiveJob].self, from: data)
                    DispatchQueue.main.async {
                        self.activeJobs = decodedJobs
                    }
                } catch {
                    print("Failed to decode jobs: \(error)")
                }
            }
        }, errorHandler: { error in
            print("Fetch jobs error: \(error.localizedDescription)")
        })
    }

    func cancelJob(jobId: String, completion: @escaping (String) -> Void) {
        guard WCSession.default.isReachable else {
            completion("Offline: Cannot cancel job")
            return
        }
        
        WCSession.default.sendMessage(["action": "cancel_job", "job_id": jobId], replyHandler: { reply in
            if let error = reply["error"] as? String {
                completion(error)
            } else {
                completion("Job cancelled")
                self.fetchJobs()
            }
        }, errorHandler: { error in
            completion(error.localizedDescription)
        })
    }

    func performNextAction(_ action: NextActionPayload, jobId: String, completion: @escaping (String) -> Void) {
        switch action.kind {
        case "api_call":
            if action.id == "summarize-progress" || action.target?.hasSuffix("/summarize") == true {
                summarizeJob(jobId: jobId, completion: completion)
                return
            }

            if action.id == "cancel-job" || action.target?.hasSuffix("/cancel") == true {
                cancelJob(jobId: jobId, completion: completion)
                return
            }

            completion("Unsupported action: \(action.label)")
        case "hint":
            completion(action.label)
        default:
            completion("Unsupported action: \(action.label)")
        }
    }

    func summarizeJob(jobId: String, completion: @escaping (String) -> Void) {
        guard WCSession.default.isReachable else {
            completion("Offline: Cannot summarize job")
            return
        }
        
        WCSession.default.sendMessage(["action": "summarize_job", "job_id": jobId], replyHandler: { reply in
            if let error = reply["error"] as? String {
                completion(error)
                return
            }

            let summary = reply["summary"] as? String ?? "Unknown response"
            let requiresPhoneHandoff = reply["requires_phone_handoff"] as? Bool ?? false
            let handoffUrl = reply["handoff_url"] as? String
            let transcript = reply["transcript"] as? String
            let phoneReport = reply["phone_report"] as? String
            let reportMeta = self.reportMeta(from: reply["report_meta"])
            let previewSections = self.previewSections(from: reply["preview_sections"])
            let reportSections = self.reportSections(from: reply["report_sections"])

            DispatchQueue.main.async {
                self.responseText = summary
                self.handoffUrl = requiresPhoneHandoff ? handoffUrl : nil
                self.handoffJobId = requiresPhoneHandoff ? jobId : nil
                self.handoffState = requiresPhoneHandoff && handoffUrl != nil ? .ready : .idle
                self.handoffPreview = requiresPhoneHandoff && handoffUrl != nil
                    ? HandoffPreview(
                        transcript: transcript,
                        summaryText: reportMeta?.watchSummary ?? summary,
                        phoneReport: reportMeta?.phoneReport ?? phoneReport,
                        category: reportMeta?.category,
                        nextAction: reportMeta?.nextAction,
                        retryCount: reportMeta?.retryCount ?? 0,
                        failureCode: reportMeta?.failureCode,
                        failureMessage: reportMeta?.failureMessage,
                        reportSections: reportSections,
                        previewSections: previewSections
                    )
                    : nil
            }
            completion(summary)
            self.fetchJobs()
        }, errorHandler: { error in
            completion(error.localizedDescription)
        })
    }

    func openHandoff(url explicitUrl: String? = nil, jobId: String? = nil) {
        guard let url = explicitUrl ?? handoffUrl, WCSession.default.isReachable else { return }
        WCSession.default.sendMessage(["action": "open_handoff", "url": url]) { reply in
            DispatchQueue.main.async {
                if let jobId {
                    self.handoffJobId = jobId
                }
                if let error = reply["error"] as? String {
                    self.handoffState = .ready
                    self.responseText = "Handoff error: \(error)"
                    return
                }

                let status = reply["status"] as? String ?? "opened"
                switch status {
                case "pending":
                    self.handoffState = .pendingOnPhone
                    self.responseText = "Ready on iPhone"
                default:
                    self.handoffState = .openedOnPhone
                    self.responseText = "Opened on iPhone"
                }
            }
        } errorHandler: { error in
            DispatchQueue.main.async {
                self.handoffState = .ready
                self.responseText = "Handoff error: \(error.localizedDescription)"
            }
        }
    }

    func sendAudioCommand(audioBase64: String) {
        let request = WatchCommandRequest(
            audioData: audioBase64,
            format: "m4a",
            clientTimestamp: ISO8601DateFormatter().string(from: Date())
        )

        guard let data = try? JSONEncoder().encode(request) else {
            DispatchQueue.main.async {
                self.responseText = "Encoding Error"
            }
            return
        }

        if !WCSession.default.isReachable { 
            self.queueCommand(audioBase64: audioBase64) 
            return 
        } 

        // Start extended session to keep watch awake during transfer
        self.startExtendedSession()

        DispatchQueue.main.async {
            self.responseText = "Sending..."
            self.handoffUrl = nil
            self.handoffJobId = nil
            self.handoffState = .idle
            self.handoffPreview = nil
        }

        WCSession.default.sendMessageData(data, replyHandler: { replyData in
            // Stop extended session on success
            self.stopExtendedSession()
            
            guard let response = try? JSONDecoder().decode(WatchCommandResponse.self, from: replyData) else {
                DispatchQueue.main.async {
                    self.responseText = "Invalid Response"
                    self.handoffState = .idle
                    self.handoffPreview = nil
                }
                return
            }

            DispatchQueue.main.async {
                self.responseText = response.summaryText
                let effectiveRequiresPhoneHandoff = response.reportMeta?.requiresPhoneHandoff ?? response.requiresPhoneHandoff
                self.handoffUrl = effectiveRequiresPhoneHandoff ? response.handoffUrl : nil
                self.handoffJobId = effectiveRequiresPhoneHandoff ? response.jobId : nil
                self.handoffState = effectiveRequiresPhoneHandoff && response.handoffUrl != nil ? .ready : .idle
                self.handoffPreview = effectiveRequiresPhoneHandoff && response.handoffUrl != nil
                    ? HandoffPreview(
                        transcript: response.transcript,
                        summaryText: response.reportMeta?.watchSummary ?? response.summaryText,
                        phoneReport: response.reportMeta?.phoneReport ?? response.phoneReport,
                        category: response.reportMeta?.category,
                        nextAction: response.reportMeta?.nextAction,
                        retryCount: response.reportMeta?.retryCount ?? 0,
                        failureCode: response.reportMeta?.failureCode,
                        failureMessage: response.reportMeta?.failureMessage,
                        reportSections: response.reportSections,
                        previewSections: response.previewSections
                    )
                    : nil

                if let ttsBase64 = response.ttsAudioData, let format = response.ttsFormat {
                    self.audioPlayerManager?.play(base64Data: ttsBase64, format: format)
                }
            }
        }, errorHandler: { error in
            // Stop extended session on error
            self.stopExtendedSession()
            
            DispatchQueue.main.async {
                self.handoffJobId = nil
                self.handoffState = .idle
                self.handoffPreview = nil
                self.responseText = "Error: \(error.localizedDescription)"
                // Re-queue on failure if it was a connectivity error
                self.queueCommand(audioBase64: audioBase64)
            }
        })
    }
    
    private func queueCommand(audioBase64: String) { 
        // Ensure session is stopped if we fallback to queue
        self.stopExtendedSession()
        
        let newCommand = QueuedCommand( 
            id: UUID().uuidString, 
            audioData: audioBase64, 
            timestamp: Date(), 
            retryCount: 0 
        ) 
        DispatchQueue.main.async { 
            // Avoid duplicates in queue
            if !self.pendingCommands.contains(where: { $0.audioData == audioBase64 }) {
                self.pendingCommands.append(newCommand) 
            }
            self.responseText = "Offline. Command queued." 
            WKInterfaceDevice.current().play(.retry) 
        } 
    } 

    func processQueue() { 
        guard WCSession.default.isReachable, !pendingCommands.isEmpty else { return } 
        
        let commandsToProcess = pendingCommands 
        DispatchQueue.main.async { 
            self.pendingCommands = [] 
            self.responseText = "Processing queued commands..." 
        } 
        
        // Process sequentially to avoid session flooding
        func sendNext(index: Int) {
            guard index < commandsToProcess.count else {
                DispatchQueue.main.async {
                    self.fetchJobs()
                }
                return
            }
            
            var command = commandsToProcess[index]
            command.retryCount += 1
            
            // Note: Since sendAudioCommand is async, we'd ideally wait for completion.
            // For now, we'll trigger them with a small delay to respect the radio.
            self.sendAudioCommand(audioBase64: command.audioData)
            
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                sendNext(index: index + 1)
            }
        }
        
        sendNext(index: 0)
    } 

    func updateJobStatus(jobId: String, newStatus: String) {
        // Geçici olarak job durumunu güncelle (optimistic update)
        if let index = activeJobs.firstIndex(where: { $0.id == jobId }) {
            var updatedJob = activeJobs[index]
            updatedJob.status = newStatus
            activeJobs[index] = updatedJob
        }
    }
}
