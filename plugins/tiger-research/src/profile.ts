export const RESEARCH_STRENGTH_PROFILES = ["low", "mid", "high", "ultra"] as const;

export type ResearchStrengthProfile = (typeof RESEARCH_STRENGTH_PROFILES)[number];

export type ResearchProfileConfig = {
  planner: {
    claimCount: { min: number; max: number };
    timeoutSeconds: number;
    parseRegenRetries: number;
  };
  quality: {
    minEvidencePerClaim: number;
    minDistinctDomainsPerClaim: number;
    requireCounterEvidence: boolean;
  };
};

const PROFILE_CONFIG: Record<ResearchStrengthProfile, ResearchProfileConfig> = {
  low: {
    planner: {
      claimCount: { min: 2, max: 5 },
      timeoutSeconds: 90,
      parseRegenRetries: 1,
    },
    quality: {
      minEvidencePerClaim: 1,
      minDistinctDomainsPerClaim: 1,
      requireCounterEvidence: false,
    },
  },
  mid: {
    planner: {
      claimCount: { min: 4, max: 8 },
      timeoutSeconds: 150,
      parseRegenRetries: 2,
    },
    quality: {
      minEvidencePerClaim: 2,
      minDistinctDomainsPerClaim: 2,
      requireCounterEvidence: true,
    },
  },
  high: {
    planner: {
      claimCount: { min: 6, max: 10 },
      timeoutSeconds: 210,
      parseRegenRetries: 3,
    },
    quality: {
      minEvidencePerClaim: 3,
      minDistinctDomainsPerClaim: 2,
      requireCounterEvidence: true,
    },
  },
  ultra: {
    planner: {
      claimCount: { min: 8, max: 12 },
      timeoutSeconds: 300,
      parseRegenRetries: 4,
    },
    quality: {
      minEvidencePerClaim: 4,
      minDistinctDomainsPerClaim: 3,
      requireCounterEvidence: true,
    },
  },
};

export function isResearchStrengthProfile(value: string): value is ResearchStrengthProfile {
  return RESEARCH_STRENGTH_PROFILES.includes(value as ResearchStrengthProfile);
}

export function resolveResearchStrengthProfile(
  value: string | null | undefined,
): ResearchStrengthProfile {
  if (!value) {
    return "mid";
  }
  const normalized = value.trim().toLowerCase();
  if (isResearchStrengthProfile(normalized)) {
    return normalized;
  }
  throw new Error(
    `Invalid research profile: ${value}. Expected one of ${RESEARCH_STRENGTH_PROFILES.join(", ")}.`,
  );
}

export function getResearchProfileConfig(profile: ResearchStrengthProfile): ResearchProfileConfig {
  return PROFILE_CONFIG[profile];
}
