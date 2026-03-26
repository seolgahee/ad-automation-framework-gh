import 'dotenv/config';
import { getGoogleClient } from '../src/utils/clients.js';
import { enums } from 'google-ads-api';
const g = getGoogleClient();
const id = process.argv[2];
if (!id) { console.log('Usage: node scripts/_delete-test-campaign.js <campaignId>'); process.exit(1); }
try {
  await g.customer.campaigns.update([{ resource_name: `customers/${g.customerId}/campaigns/${id}`, status: enums.CampaignStatus.REMOVED }]);
  console.log(`Deleted campaign ${id}`);
} catch(e) { console.log('Failed:', e.message); }
