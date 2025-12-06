import { Dataset } from 'crawlee';

// Helper to handle Cloudflare challenge in new tabs
async function handleCloudflareInNewTab(page: any, log: any) {
    log.info('Checking for Cloudflare in new tab...');
    try {
        const iframeSelector = 'iframe[src*="cloudflare-challenge"], iframe[src*="turnstile"]';
        const iframeElement = await page.waitForSelector(iframeSelector, { timeout: 10000 }).catch(() => null);

        if (iframeElement) {
            log.info('Cloudflare/Turnstile iframe detected in new tab.');
            await page.waitForTimeout(3000); // Give more time for new tab
            
            const frames = page.frames();
            const challengeFrame = frames.find((f: any) => f.url().includes('cloudflare-challenge') || f.url().includes('turnstile'));
            
            if (challengeFrame) {
                log.info('Found challenge frame in new tab. Attempting to solve...');
                const checkbox = challengeFrame.locator('input[type="checkbox"]').first();
                const label = challengeFrame.locator('label').first();
                
                if (await checkbox.isVisible()) {
                    await checkbox.click();
                    log.info('Clicked Cloudflare checkbox in new tab.');
                } else if (await label.isVisible()) {
                    await label.click();
                    log.info('Clicked Cloudflare label in new tab.');
                }
                
                await page.waitForTimeout(5000); // Wait for challenge to complete
            }
        } else {
            log.info('No Cloudflare challenge detected in new tab.');
        }
    } catch (error) {
        log.warning(`Error handling Cloudflare in new tab: ${error}`);
    }
}

// Helper to handle new tab/page navigation
export async function handleNewTabNavigation(page: any, buttonSelector: string, log: any) {
    log.info(`Setting up new tab handler for: ${buttonSelector}`);
    
    // Get initial page count
    const initialPages = page.context().pages();
    log.info(`Initial page count: ${initialPages.length}`);
    
    // Listen for new page (tab) events with timeout
    const newPagePromise = page.context().waitForEvent('page', { timeout: 10000 });
    
    // Click the button that opens new tab
    log.info('Clicking button to open new tab...');
    await page.locator(buttonSelector).click();
    
    try {
        // Wait for the new page to open
        const newPage = await newPagePromise;
        
        log.info(`New page event detected: ${newPage.url()}`);
        
        // Wait for the new page to load
        await newPage.waitForLoadState('networkidle');
        
        log.info(`New tab opened and loaded: ${newPage.url()}`);
        
        // Handle Cloudflare challenge in the new tab if present
        await handleCloudflareInNewTab(newPage, log);
        
        return newPage;
        
    } catch (error) {
        // Check if page count actually increased
        const currentPages = page.context().pages();
        log.info(`After click page count: ${currentPages.length}`);
        
        if (currentPages.length > initialPages.length) {
            log.info('New page detected despite event timeout, using latest page');
            const newPage = currentPages[currentPages.length - 1];
            await newPage.waitForLoadState('networkidle');
            await handleCloudflareInNewTab(newPage, log);
            return newPage;
        }
        
        log.error(`New tab navigation failed: ${error}`);
        throw error;
    }
}

// Helper to handle popup windows
export async function handlePopupNavigation(page: any, buttonSelector: string, log: any) {
    log.info(`Setting up popup handler for: ${buttonSelector}`);
    
    // Listen for popup events
    const popupPromise = page.waitForEvent('popup');
    
    // Click the button that opens popup
    await page.locator(buttonSelector).click();
    
    // Wait for the popup to open
    const popup = await popupPromise;
    
    // Wait for the popup to load
    await popup.waitForLoadState('networkidle');
    
    log.info(`Popup opened: ${popup.url()}`);
    
    return popup;
}

// Helper to manage multiple tabs and extract data from each
export async function processMultipleTabs(page: any, log: any, enqueueLinks: any) {
    const context = page.context();
    const allPages = context.pages();
    
    log.info(`Found ${allPages.length} open tabs/pages`);
    
    for (const [index, currentPage] of allPages.entries()) {
        try {
            log.info(`Processing tab ${index + 1}: ${currentPage.url()}`);
            
            // Bring the tab to front
            await currentPage.bringToFront();
            
            // Wait for the page to be ready
            await currentPage.waitForLoadState('networkidle');
            
            // Extract data from this tab
            await extractDataFromPage(currentPage, log);
            
            // Look for more links to enqueue from this tab
            await enqueueLinks({
                selector: 'a[href]',
                label: 'ADDITIONAL_PAGE',
                transformRequestFunction: (req: any) => {
                    // Add metadata about which tab this came from
                    req.userData = { 
                        ...req.userData, 
                        sourceTab: index,
                        sourceUrl: currentPage.url()
                    };
                    return req;
                }
            });
            
        } catch (error) {
            log.error(`Error processing tab ${index + 1}: ${error}`);
        }
    }
}

// Helper to extract data from any page
export async function extractDataFromPage(page: any, log: any) {
    try {
        // Extract page metadata
        const pageData = {
            url: page.url(),
            title: await page.title(),
            extractedAt: new Date().toISOString(),
            type: 'page_info'
        };
        
        await Dataset.pushData(pageData);
        log.info(`Stored page info for: ${page.url()}`);
        
        // Extract any forms or important elements
        const forms = await page.evaluate(() => {
            const allForms = Array.from(document.querySelectorAll('form'));
            return allForms.map((form, index) => ({
                action: (form as HTMLFormElement).action || '',
                method: (form as HTMLFormElement).method || 'GET',
                id: form.id || undefined,
                className: form.className || undefined,
                inputCount: form.querySelectorAll('input').length,
                position: index
            }));
        });
        
        // Store form data
        for (const form of forms) {
            await Dataset.pushData({
                ...form,
                type: 'form',
                pageUrl: page.url(),
                pageTitle: await page.title(),
                extractedAt: new Date().toISOString()
            });
        }
        
        if (forms.length > 0) {
            log.info(`Extracted and stored ${forms.length} forms from ${page.url()}`);
        }
        
    } catch (error) {
        log.error(`Error extracting data from page: ${error}`);
    }
}

// Helper to check if a button/link opens in new tab
export async function checkNewTabBehavior(page: any, selector: string, log: any): Promise<'new_tab' | 'popup' | 'same_page'> {
    try {
        const element = page.locator(selector).first();
        await element.waitFor({ timeout: 5000 });
        
        // Check target attribute
        const target = await element.getAttribute('target');
        if (target === '_blank' || target === '_new') {
            log.info(`Element ${selector} has target="${target}" - likely opens new tab`);
            return 'new_tab';
        }
        
        // Check onclick behavior
        const onclick = await element.getAttribute('onclick');
        if (onclick && (onclick.includes('window.open') || onclick.includes('popup'))) {
            log.info(`Element ${selector} has popup-like onclick - likely opens popup`);
            return 'popup';
        }
        
        // Check for common popup classes
        const className = await element.getAttribute('class') || '';
        if (className.includes('popup') || className.includes('modal') || className.includes('overlay')) {
            log.info(`Element ${selector} has popup-like class - might open popup`);
            return 'popup';
        }
        
        log.info(`Element ${selector} appears to navigate in same page`);
        return 'same_page';
        
    } catch (error) {
        log.warning(`Could not determine navigation behavior for ${selector}: ${error}`);
        return 'same_page';
    }
}

// Helper to extract URL from link and open in new tab manually
async function forceNewTabNavigation(page: any, selector: string, log: any) {
    log.info('Attempting to force new tab navigation by extracting URL...');
    
    try {
        // Get the href attribute from the link
        const element = page.locator(selector).first();
        const href = await element.getAttribute('href');
        
        if (!href) {
            throw new Error('No href attribute found on element');
        }
        
        log.info(`Extracted URL: ${href}`);
        
        // Create a new page manually
        const context = page.context();
        const newPage = await context.newPage();
        
        // Navigate to the URL
        await newPage.goto(href);
        await newPage.waitForLoadState('networkidle');
        
        log.info(`Manually opened new tab: ${newPage.url()}`);
        
        // Handle Cloudflare challenge in the new tab if present
        await handleCloudflareInNewTab(newPage, log);
        
        return newPage;
        
    } catch (error) {
        log.error(`Force new tab navigation failed: ${error}`);
        throw error;
    }
}

// Comprehensive navigation handler that tries all methods
export async function handleSmartNavigation(page: any, selector: string, log: any) {
    const behavior = await checkNewTabBehavior(page, selector, log);
    
    switch (behavior) {
        case 'new_tab':
            try {
                return await handleNewTabNavigation(page, selector, log);
            } catch (e) {
                log.warning('New tab navigation failed, trying manual URL extraction...');
                try {
                    return await forceNewTabNavigation(page, selector, log);
                } catch (forceError) {
                    log.warning('Force navigation failed, trying popup...');
                    try {
                        return await handlePopupNavigation(page, selector, log);
                    } catch (popupError) {
                        log.warning('All navigation methods failed, falling back to same page...');
                        await page.locator(selector).click();
                        return page;
                    }
                }
            }
            
        case 'popup':
            try {
                return await handlePopupNavigation(page, selector, log);
            } catch (e) {
                log.warning('Popup navigation failed, trying new tab...');
                try {
                    return await handleNewTabNavigation(page, selector, log);
                } catch (tabError) {
                    log.warning('New tab navigation failed, trying manual URL extraction...');
                    try {
                        return await forceNewTabNavigation(page, selector, log);
                    } catch (forceError) {
                        log.warning('All methods failed, falling back to same page...');
                        await page.locator(selector).click();
                        return page;
                    }
                }
            }
            
        case 'same_page':
        default:
            await page.locator(selector).click();
            return page;
    }
}
