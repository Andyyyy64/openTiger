import { describe, expect, it } from "vitest";
import {
  evaluateResearchQualityGate,
  normalizeResearchStage,
} from "../../../plugins/tiger-research/src/cycle/orchestrator";

describe("normalizeResearchStage", () => {
  it("normalizes stage aliases", () => {
    expect(normalizeResearchStage("planning")).toBe("plan");
    expect(normalizeResearchStage("collect")).toBe("collect");
    expect(normalizeResearchStage("challenging")).toBe("challenge");
    expect(normalizeResearchStage("compose")).toBe("write");
  });
});

describe("evaluateResearchQualityGate", () => {
  const thresholds = {
    maxConcurrency: 6,
    maxDepth: 3,
    minEvidencePerClaim: 3,
    minDistinctDomainsPerClaim: 2,
    requireCounterEvidence: true,
    minReportConfidence: 70,
    minVerifiableRatio: 0.9,
  };

  it("passes when all high-precision requirements are satisfied", () => {
    const result = evaluateResearchQualityGate(
      {
        claims: [
          { id: "c1", confidence: 90 },
          { id: "c2", confidence: 85 },
        ],
        claimProgress: [
          {
            claimId: "c1",
            claimText: "Claim 1",
            confidence: 90,
            evidenceCount: 3,
            distinctDomainCount: 2,
            counterEvidenceCount: 1,
            collectAttempts: 1,
            challengeAttempts: 1,
            hasCollectDone: true,
            hasChallengeDone: true,
            hasActiveCollect: false,
            hasActiveChallenge: false,
          },
          {
            claimId: "c2",
            claimText: "Claim 2",
            confidence: 85,
            evidenceCount: 4,
            distinctDomainCount: 3,
            counterEvidenceCount: 1,
            collectAttempts: 1,
            challengeAttempts: 1,
            hasCollectDone: true,
            hasChallengeDone: true,
            hasActiveCollect: false,
            hasActiveChallenge: false,
          },
        ],
        latestReportConfidence: 82,
        claimCitationCoverage: [
          { claimId: "c1", hasCitation: true },
          { claimId: "c2", hasCitation: true },
        ],
      },
      thresholds,
    );

    expect(result.pass).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("fails with actionable claim-level reasons", () => {
    const result = evaluateResearchQualityGate(
      {
        claims: [{ id: "c1", confidence: 60 }],
        claimProgress: [
          {
            claimId: "c1",
            claimText: "Weak claim",
            confidence: 60,
            evidenceCount: 1,
            distinctDomainCount: 1,
            counterEvidenceCount: 0,
            collectAttempts: 2,
            challengeAttempts: 1,
            hasCollectDone: true,
            hasChallengeDone: false,
            hasActiveCollect: false,
            hasActiveChallenge: false,
          },
        ],
        latestReportConfidence: 55,
        claimCitationCoverage: [{ claimId: "c1", hasCitation: false }],
      },
      thresholds,
    );

    expect(result.pass).toBe(false);
    expect(result.insufficientClaimIds).toContain("c1");
    expect(result.challengeClaimIds).toContain("c1");
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});
