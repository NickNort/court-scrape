import { createPlaywrightRouter, Dataset } from 'crawlee';
import { Actor } from 'apify';

// Helper to handle Cloudflare Turnstile
async function handleCloudflareChallenge(page: any, log: any) {
    log.info('Checking for Cloudflare Turnstile...');
    try {
        // Wait for the iframe to appear (short timeout)
        const iframeSelector = 'iframe[src*="cloudflare-challenge"], iframe[src*="turnstile"]';
        // We use a short timeout because if it's not there, we want to move on.
        const iframeElement = await page.waitForSelector(iframeSelector, { timeout: 6000 }).catch(() => null);

        if (iframeElement) {
            log.info('Cloudflare/Turnstile iframe detected.');
            // Give it a moment to render content
            await page.waitForTimeout(2000);
            
            // Get the frame
            const frames = page.frames();
            const challengeFrame = frames.find((f: any) => f.url().includes('cloudflare-challenge') || f.url().includes('turnstile'));
            
            if (challengeFrame) {
                 log.info('Found challenge frame. Attempting to click checkbox...');
                 // Try different selectors for the checkbox/button
                 // 1. The checkbox itself
                 const checkbox = challengeFrame.locator('input[type="checkbox"]').first();
                 // 2. The label usually wrapping it
                 const label = challengeFrame.locator('label').first(); 
                 // 3. Specific class often used
                 const button = challengeFrame.locator('.ct-checkbox-label').first();
                 
                 if (await checkbox.isVisible()) {
                     await checkbox.click();
                     log.info('Clicked checkbox input.');
                 } else if (await label.isVisible()) {
                     await label.click();
                      log.info('Clicked label.');
                 } else if (await button.isVisible()) {
                     await button.click();
                     log.info('Clicked .ct-checkbox-label.');
                 } else {
                     // Last resort: click coordinates in the frame
                     log.info('No specific element found, clicking body of frame...');
                     await challengeFrame.locator('body').click({ position: { x: 30, y: 30 } });
                 }
                 
                 // Wait for the challenge to process
                 await page.waitForTimeout(3000);
            }
        } else {
            log.info('No Cloudflare iframe detected immediately.');
        }
    } catch (error) {
        log.warning(`Error handling Cloudflare: ${error}`);
    }
}

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, log, enqueueLinks }) => {
    log.info(`Processing start page: ${page.url()}`);

    // 1. Locate & Click "Access Now" under "Civil Case Query"
    // Use a robust XPath to find the "Access Now" link that follows the "Civil Case Query" text.
    // This finds an element containing "Civil Case Query" and then looks for the first following "Access Now" link.
    const accessNowSelector = 'xpath=//*[contains(text(), "Civil Case Query")]/following::a[contains(text(), "Access Now")]';
    
    log.info('Looking for "Access Now" button under Civil Case Query...');
    try {
        const accessButton = page.locator(accessNowSelector).first();
        await accessButton.waitFor({ timeout: 10000 });
        await accessButton.click();
    } catch (e) {
        log.warning('Specific XPath selector failed, trying looser text match for "Access Now"...');
        // Fallback: Click the first "Access Now" on the page if the specific one fails?
        // Or maybe the section text is slightly different.
        // Let's try finding just "Access Now" and hoping it's the right one (often the first or only one visible).
        await page.getByText('Access Now').first().click();
    }

    // Attempt to handle Cloudflare if present
    await handleCloudflareChallenge(page, log);

    // 2. Handle Cloudflare / Wait for "Search by New Filings"
    log.info('Waiting for next page (and Cloudflare check)...');
    
    // We wait for the text "Search by New Filings" which appears on the destination page.
    // This implicitly waits for any Cloudflare challenge to complete.
    try {
        await page.getByText('Search by New Filings').waitFor({ timeout: 20000 }); // 15s timeout for Cloudflare
        log.info('Found "Search by New Filings" text.');
    } catch (e) {
        log.error('Timed out waiting for "Search by New Filings". Cloudflare might have blocked us or page layout changed.');
        throw e;
    }

    // 3. Click "Search by New Filings"
    log.info('Clicking "Search by New Filings"...');
    await page.getByText('Search by New Filings').click();
    
    // 4. Click "Search"
    // This usually reveals the search form or executes a default search.
    // Assuming we just need to click "Search" button now.
    log.info('Clicking "Search"...');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    
    // 5. Wait for results
    log.info('Waiting for search results table...');
    // Wait for the results table to load. "Case Number" is a likely column header.
    try {
        await page.getByText('Case Number').first().waitFor({ timeout: 30000 });
    } catch (e) {
        log.warning('Did not find "Case Number" text. Search might have returned no results or layout is different.');
    }
    
    // 6. Enqueue Case Details
    // Target the table rows. We want the links in the "Case Number" column.
    // We'll enqueue all links found in the table body to be safe, filtering for case-like URLs if possible.
    log.info('Enqueueing case details...');
    
    // Refined selector: Look for links inside table cells.
    // Often there's a specific class, but generic 'tr td a' is usually safe for data tables.
    await enqueueLinks({
        selector: 'table tbody tr td a',
        label: 'CASE_DETAIL',
        transformRequestFunction: (req) => {
            // Optional: Filter URLs here if needed.
            // For now, accept all links from the table.
            return req;
        }
    });
});

router.addHandler('CASE_DETAIL', async ({ request, page, log }) => {
    log.info(`Processing case details: ${request.url}`);
    
    // 1. Locate "Document" column/table
    // Wait for the page to load the documents table.
    try {
        // Look for "Document" header or similar
        await page.getByText('Document').first().waitFor({ timeout: 15000 });
    } catch (e) {
        log.warning(`No "Document" column found on ${request.url}, skipping or page empty.`);
        return;
    }

    // 2. Iterate rows and download
    // We look for rows that contain a "View" button/link.
    const viewButtons = page.locator('tr').filter({ hasText: 'View' }).getByText('View');
    const count = await viewButtons.count();
    
    log.info(`Found ${count} documents to download.`);
    
    for (let i = 0; i < count; i++) {
        // We re-query the button to avoid stale element handle issues if the DOM updates
        const button = viewButtons.nth(i);
        
        // Setup download listener
        const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
        
        try {
            // Click the view button
            await button.click();
            
            // Wait for download to start
            const download = await downloadPromise;
            
            const suggestedFilename = download.suggestedFilename();
            log.info(`Downloading file: ${suggestedFilename}`);
            
            // Get a readable stream of the file
            const stream = await download.createReadStream();
            
            // Generate a unique key for the KV store
            // Sanitizing filename and adding a timestamp/index to prevent collisions
            const safeFilename = suggestedFilename.replace(/[^a-zA-Z0-9.-]/g, '_');
            const key = `PDF_${Date.now()}_${i}_${safeFilename}`;
            
            // Save to Key-Value Store
            await Actor.setValue(key, stream, { contentType: 'application/pdf' });
            
            // Push metadata to Dataset
            await Dataset.pushData({
                type: 'document',
                caseUrl: request.url,
                originalFilename: suggestedFilename,
                storageKey: key,
                downloadedAt: new Date().toISOString(),
                // Try to capture some row context (e.g. Document Type) if possible
                // We could traverse up from the button to the row, but that's complex without specific selectors.
                // Keeping it simple for now.
            });
            
            log.info(`Saved ${suggestedFilename} as ${key}`);
            
        } catch (err) {
            log.error(`Failed to download/save document ${i + 1}/${count}: ${err}`);
        }
    }
});
