import { writeFileSync } from 'fs';

interface SearchResult {
  url: string;
  title: string;
  excerpt: string;
  post_number: number;
}

interface DiscourseSearchResponse {
  posts?: SearchResult[];
  topics?: Array<{
    id: number;
    title: string;
    slug: string;
    category_id: number;
  }>;
}

interface ForumThreadResult {
  url: string;
  title: string;
  found: boolean;
  error?: string;
}

const FORUM_BASE_URL = 'https://forum.dfinity.org';
const NNS_CATEGORY_ID = 76;

async function fetchForumCookies(
  portalUrl: string,
  secret: string
): Promise<string> {
  const response = await fetch(`${portalUrl}/api/forum-cookies`, {
    headers: {
      Authorization: `Bearer ${secret}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to fetch cookies: HTTP ${response.status} - ${text}`
    );
  }

  const data = await response.json();
  return data.cookies; // Cookie header string
}

async function searchForum(
  proposalId: string,
  cookies: string
): Promise<DiscourseSearchResponse> {
  const searchUrl = `${FORUM_BASE_URL}/search.json?q=${encodeURIComponent(proposalId)}`;

  console.log(`Searching forum: ${searchUrl}`);

  const response = await fetch(searchUrl, {
    headers: {
      Cookie: cookies,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Forum search failed: HTTP ${response.status}`);
  }

  return await response.json();
}

async function verifyThread(
  topicId: number,
  slug: string,
  proposalId: string,
  cookies: string
): Promise<boolean> {
  const threadUrl = `${FORUM_BASE_URL}/t/${slug}/${topicId}.json`;

  const response = await fetch(threadUrl, {
    headers: {
      Cookie: cookies,
      Accept: 'application/json'
    }
  });

  if (!response.ok) return false;

  const data = await response.json();
  const firstPost = data.post_stream?.posts?.[0];

  if (!firstPost) return false;

  // Check if proposal ID appears in first post
  const postText = firstPost.cooked || firstPost.raw || '';
  return postText.includes(proposalId);
}

async function findForumThread(
  proposalId: string,
  cookies: string
): Promise<ForumThreadResult> {
  try {
    // Search forum
    const searchResults = await searchForum(proposalId, cookies);

    if (!searchResults.topics || searchResults.topics.length === 0) {
      return {
        url: '',
        title: '',
        found: false,
        error: 'No search results found'
      };
    }

    // Filter to NNS category
    const nnsThreads = searchResults.topics.filter(
      (t) => t.category_id === NNS_CATEGORY_ID
    );

    if (nnsThreads.length === 0) {
      return {
        url: '',
        title: '',
        found: false,
        error: `Found ${searchResults.topics.length} results but none in NNS category`
      };
    }

    // Verify each thread
    for (const thread of nnsThreads) {
      const isValid = await verifyThread(
        thread.id,
        thread.slug,
        proposalId,
        cookies
      );

      if (isValid) {
        const url = `${FORUM_BASE_URL}/t/${thread.slug}/${thread.id}`;
        return {
          url,
          title: thread.title,
          found: true
        };
      }
    }

    // No verified threads
    return {
      url: '',
      title: '',
      found: false,
      error: `Found ${nnsThreads.length} potential threads but none contained proposal ID`
    };
  } catch (error) {
    return {
      url: '',
      title: '',
      found: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

async function postForumUrl(
  portalUrl: string,
  secret: string,
  proposalId: string,
  forumUrl: string,
  threadTitle: string
): Promise<void> {
  const response = await fetch(`${portalUrl}/api/forum-links`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`
    },
    body: JSON.stringify({
      proposalId,
      forumUrl,
      threadTitle
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to post forum URL: HTTP ${response.status} - ${text}`);
  }
}

async function main() {
  const proposalId = process.argv[2];
  const portalUrl = process.env.PORTAL_URL;
  const commentarySecret = process.env.COMMENTARY_SECRET;
  const forumLinkSecret = process.env.FORUM_LINK_SECRET;

  if (!proposalId) {
    console.error('Usage: npx tsx src/search-forum.ts <proposal_id>');
    process.exit(1);
  }

  if (!portalUrl || !commentarySecret || !forumLinkSecret) {
    console.error('Missing environment variables:');
    console.error('  PORTAL_URL:', portalUrl ? 'set' : 'MISSING');
    console.error('  COMMENTARY_SECRET:', commentarySecret ? 'set' : 'MISSING');
    console.error(
      '  FORUM_LINK_SECRET:',
      forumLinkSecret ? 'set' : 'MISSING'
    );
    process.exit(1);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SEARCHING DFINITY FORUM FOR PROPOSAL DISCUSSION');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`Proposal ID: ${proposalId}`);
  console.log('');

  try {
    // Fetch cookies from portal
    console.log('Fetching forum cookies from portal...');
    const cookies = await fetchForumCookies(portalUrl, commentarySecret);
    console.log('✓ Cookies retrieved');
    console.log('');

    // Search forum
    console.log('Searching forum...');
    const result = await findForumThread(proposalId, cookies);

    if (result.found) {
      console.log('✓ Forum thread found!');
      console.log(`  URL: ${result.url}`);
      console.log(`  Title: ${result.title}`);
      console.log('');

      // Post to portal
      console.log('Posting forum URL to portal...');
      await postForumUrl(
        portalUrl,
        forumLinkSecret,
        proposalId,
        result.url,
        result.title
      );
      console.log('✓ Forum URL posted to portal');

      // Write to file for workflow output
      writeFileSync('forum-result.json', JSON.stringify(result, null, 2));
    } else {
      console.log('⚠️  No forum thread found');
      if (result.error) {
        console.log(`  Reason: ${result.error}`);
      }
      console.log('');
      console.log(
        'This is not an error - not all proposals have forum discussions.'
      );

      // Write result anyway
      writeFileSync('forum-result.json', JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error('❌ Forum search failed:', error);
    console.error('');
    console.error(
      'This is a non-fatal error. Commentary will continue without forum link.'
    );

    // Write error result
    const errorResult: ForumThreadResult = {
      url: '',
      title: '',
      found: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
    writeFileSync('forum-result.json', JSON.stringify(errorResult, null, 2));

    // Exit 0 to not block workflow
    process.exit(0);
  }
}

main();
