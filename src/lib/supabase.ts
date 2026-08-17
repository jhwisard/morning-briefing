import { createClient } from '@supabase/supabase-js';

// 환경 변수(.env.local)에서 Supabase 주소와 공개 키를 가져옵니다.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// 앱 전체에서 재사용할 단일 Supabase 클라이언트 인스턴스를 내보냅니다.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
