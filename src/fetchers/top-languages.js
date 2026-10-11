// @ts-check

import { retryer } from "../common/retryer.js";
import { logger } from "../common/log.js";
import { excludeRepositories } from "../common/envs.js";
import { CustomError, MissingParamError } from "../common/error.js";
import { wrapTextMultiline } from "../common/fmt.js";
import { request } from "../common/http.js";

const MAX_PAGES = 10;

/**
 * Top languages fetcher object.
 *
 * @param {any} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import("axios").AxiosResponse>} Languages fetcher response.
 */
const fetcher = (variables, token) => {
  return request(
    {
      query: `
      query userInfo($login: String!, $after: String, $userId: ID!) {
        user(login: $login) {
          # fetch owner, org member & collaborator repos, not forks
          repositories(ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR], isFork: false, first: 100, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              name
              owner {
                login
              }
              # user's commits on the default branch
              defaultBranchRef {
                target {
                  ... on Commit {
                    history(author: {id: $userId}) {
                      totalCount
                    }
                  }
                }
              }
              languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
                edges {
                  size
                  node {
                    color
                    name
                  }
                }
              }
            }
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `token ${token}`,
    },
  );
};

/**
 * User id fetcher object.
 *
 * @param {any} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import("axios").AxiosResponse>} User id fetcher response.
 */
const userIdFetcher = (variables, token) => {
  return request(
    {
      query: `
      query userId($login: String!) {
        user(login: $login) {
          id
        }
      }
      `,
      variables,
    },
    {
      Authorization: `token ${token}`,
    },
  );
};

/**
 * Throw a CustomError if the GraphQL response has errors.
 *
 * @param {import("axios").AxiosResponse} res GraphQL response.
 */
const throwOnErrors = (res) => {
  if (!res.data.errors) {
    return;
  }
  logger.error(res.data.errors);
  if (res.data.errors[0].type === "NOT_FOUND") {
    throw new CustomError(
      res.data.errors[0].message || "Could not fetch user.",
      CustomError.USER_NOT_FOUND,
    );
  }
  if (res.data.errors[0].message) {
    throw new CustomError(
      wrapTextMultiline(res.data.errors[0].message, 90, 1)[0],
      res.statusText,
    );
  }
  throw new CustomError(
    "Something went wrong while trying to retrieve the language data using the GraphQL API.",
    CustomError.GRAPHQL_ERROR,
  );
};

/**
 * @typedef {import("./types").TopLangData} TopLangData Top languages data.
 */

/**
 * Fetch top languages for a given username.
 *
 * @param {string} username GitHub username.
 * @param {string[]} exclude_repo List of repositories to exclude.
 * @param {number} size_weight Weightage to be given to size.
 * @param {number} count_weight Weightage to be given to count.
 * @returns {Promise<TopLangData>} Top languages data.
 */
const fetchTopLanguages = async (
  username,
  exclude_repo = [],
  size_weight = 1,
  count_weight = 0,
) => {
  if (!username) {
    throw new MissingParamError(["username"]);
  }

  const idRes = await retryer(userIdFetcher, { login: username });
  throwOnErrors(idRes);
  const userId = idRes.data.data?.user?.id;

  let repoNodes = [];
  let after = null;

  // fetch up to MAX_PAGES pages of 100 repos (top 1000)
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await retryer(fetcher, { login: username, after, userId });
    throwOnErrors(res);

    const { nodes, pageInfo } = res.data.data.user.repositories;
    repoNodes.push(...nodes);
    if (!pageInfo?.hasNextPage) {
      break;
    }
    after = pageInfo.endCursor;
  }

  // skip repos owned by others (orgs, collaborations) with none of the user's commits
  repoNodes = repoNodes.filter(
    (node) =>
      !node.owner ||
      node.owner.login.toLowerCase() === username.toLowerCase() ||
      node.defaultBranchRef?.target?.history?.totalCount > 0,
  );
  /** @type {Record<string, boolean>} */
  let repoToHide = {};
  const allExcludedRepos = [...exclude_repo, ...excludeRepositories];

  // populate repoToHide map for quick lookup
  // while filtering out
  if (allExcludedRepos) {
    allExcludedRepos.forEach((repoName) => {
      repoToHide[repoName] = true;
    });
  }

  // filter out repositories to be hidden
  repoNodes = repoNodes
    .sort((a, b) => b.size - a.size)
    .filter((name) => !repoToHide[name.name]);

  let repoCount = 0;

  repoNodes = repoNodes
    .filter((node) => node.languages.edges.length > 0)
    // flatten the list of language nodes
    .reduce((acc, curr) => curr.languages.edges.concat(acc), [])
    .reduce((acc, prev) => {
      // get the size of the language (bytes)
      let langSize = prev.size;

      // if we already have the language in the accumulator
      // & the current language name is same as previous name
      // add the size to the language size and increase repoCount.
      if (acc[prev.node.name] && prev.node.name === acc[prev.node.name].name) {
        langSize = prev.size + acc[prev.node.name].size;
        repoCount += 1;
      } else {
        // reset repoCount to 1
        // language must exist in at least one repo to be detected
        repoCount = 1;
      }
      return {
        ...acc,
        [prev.node.name]: {
          name: prev.node.name,
          color: prev.node.color,
          size: langSize,
          count: repoCount,
        },
      };
    }, {});

  Object.keys(repoNodes).forEach((name) => {
    // comparison index calculation
    repoNodes[name].size =
      Math.pow(repoNodes[name].size, size_weight) *
      Math.pow(repoNodes[name].count, count_weight);
  });

  const topLangs = Object.keys(repoNodes)
    .sort((a, b) => repoNodes[b].size - repoNodes[a].size)
    .reduce((result, key) => {
      result[key] = repoNodes[key];
      return result;
    }, {});

  return topLangs;
};

export { fetchTopLanguages };
export default fetchTopLanguages;
