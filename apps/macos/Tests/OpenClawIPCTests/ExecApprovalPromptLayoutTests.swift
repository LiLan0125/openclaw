import AppKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ExecApprovalPromptLayoutTests {
    @Test func `ask always prompts omit allow always by default`() {
        let decisions = ExecApprovalsPromptPresenter.allowedPromptDecisions(
            ExecApprovalPromptRequest(
                command: "node script.js",
                cwd: nil,
                host: "node",
                security: "allowlist",
                ask: "always",
                agentId: "main",
                resolvedPath: nil,
                sessionKey: "session-1"))

        #expect(decisions == [.allowOnce, .deny])
    }

    @Test func `ask on miss prompts keep durable approval option`() {
        let decisions = ExecApprovalsPromptPresenter.allowedPromptDecisions(
            ExecApprovalPromptRequest(
                command: "git status",
                cwd: nil,
                host: "gateway",
                security: "allowlist",
                ask: "on-miss",
                agentId: "main",
                resolvedPath: nil,
                sessionKey: "session-1"))

        #expect(decisions == [.allowOnce, .allowAlways, .deny])
    }

    @Test func `accessory view reserves nonzero alert layout space`() {
        let accessory = ExecApprovalsPromptPresenter.buildAccessoryView(
            ExecApprovalPromptRequest(
                command: "/bin/sh -lc \"hostname; uptime; echo '---'\"",
                cwd: "/Users/example/projects/openclaw",
                host: "node",
                security: "allowlist",
                ask: "on-miss",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1"))

        #expect(accessory.frame.width >= 380)
        #expect(accessory.frame.height >= 160)

        let alert = NSAlert()
        alert.messageText = "Allow this command?"
        alert.informativeText = "Review the command details before allowing."
        alert.accessoryView = accessory

        #expect(alert.accessoryView?.frame.width == accessory.frame.width)
        #expect(alert.accessoryView?.frame.height == accessory.frame.height)
    }
}
