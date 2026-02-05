import { Octokit } from "@octokit/rest";

export interface CreateRepoOptions {
  token: string;
  owner: string;
  name: string;
  description?: string;
  private?: boolean;
}

export interface RepoCreateInfo {
  owner: string;
  name: string;
  url: string;
  defaultBranch: string;
  created: boolean;
}

async function getAuthenticatedLogin(octokit: Octokit): Promise<string> {
  const response = await octokit.users.getAuthenticated();
  return response.data.login;
}

async function fetchRepo(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<RepoCreateInfo> {
  const response = await octokit.repos.get({ owner, repo });
  return {
    owner,
    name: response.data.name,
    url: response.data.html_url,
    defaultBranch: response.data.default_branch,
    created: false,
  };
}

// GitHub上にリポジトリを作成する
export async function createRepo(options: CreateRepoOptions): Promise<RepoCreateInfo> {
  const octokit = new Octokit({ auth: options.token });
  const owner = options.owner;
  const name = options.name;
  const description = options.description ?? "";
  const isPrivate = options.private ?? true;

  try {
    const login = await getAuthenticatedLogin(octokit);
    const response = login === owner
      ? await octokit.repos.createForAuthenticatedUser({
        name,
        description,
        private: isPrivate,
      })
      : await octokit.repos.createInOrg({
        org: owner,
        name,
        description,
        private: isPrivate,
      });

    return {
      owner,
      name: response.data.name,
      url: response.data.html_url,
      defaultBranch: response.data.default_branch,
      created: true,
    };
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
    if (status === 422) {
      return fetchRepo(octokit, owner, name);
    }
    throw error;
  }
}
