import { test, expect } from '@playwright/test';

test.describe('Homepage', () => {
  test('should display the hero section', async ({ page }) => {
    await page.goto('/');

    // Check hero heading
    await expect(page.getByRole('heading', { name: /Building the Future of Commerce/i })).toBeVisible();

    // Check CTA buttons
    await expect(page.getByRole('link', { name: /Explore Products/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Contact Sales/i })).toBeVisible();
  });

  test('should display navigation', async ({ page }) => {
    await page.goto('/');

    // Check nav links
    await expect(page.getByRole('link', { name: 'Products' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'About' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Contact' })).toBeVisible();
  });

  test('should navigate to products page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Products' }).first().click();
    await expect(page).toHaveURL('/products');
  });

  test('should navigate to about page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'About' }).first().click();
    await expect(page).toHaveURL('/about');
  });

  test('should navigate to contact page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Contact' }).first().click();
    await expect(page).toHaveURL('/contact');
  });
});

test.describe('Marketing Pages', () => {
  test('about page loads correctly', async ({ page }) => {
    await page.goto('/about');
    await expect(page.getByRole('heading', { name: 'About Tesserix' })).toBeVisible();
  });

  test('products page loads correctly', async ({ page }) => {
    await page.goto('/products');
    await expect(page.getByRole('heading', { name: 'Our Products' })).toBeVisible();
  });

  test('contact page loads correctly', async ({ page }) => {
    await page.goto('/contact');
    await expect(page.getByRole('heading', { name: 'Get in Touch' })).toBeVisible();
  });

  test('Mark8ly product page loads correctly', async ({ page }) => {
    await page.goto('/products/mark8ly');
    await expect(page.getByRole('heading', { name: 'Mark8ly' })).toBeVisible();
  });
});

test.describe('API Health', () => {
  test('health endpoint returns healthy', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.ok()).toBeTruthy();
    const json = await response.json();
    expect(json.status).toBe('healthy');
  });
});
