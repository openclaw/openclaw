import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function querySchema() {
  // Just fetch a sample record to see the columns
  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log('Sample profile record:');
  console.log(profiles[0]);

  console.log('\n📋 Columns in profiles table:');
  if (profiles[0]) {
    Object.keys(profiles[0]).forEach(key => {
      const value = profiles[0][key];
      const type = value === null ? 'null' : typeof value;
      console.log('  ✓', key + ':', type);
    });
  }
}

querySchema();
