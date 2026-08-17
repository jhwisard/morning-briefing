export interface NewsItem {
  text: string;
  source: string;
}

export interface BriefingSection {
  id: string;
  category: string;
  icon: string;
  items: NewsItem[];
}

export interface Briefing {
  id: string;
  briefing_date: string;
  category_type: string;
  title: string;
  weather: string | null;
  highlights: string[];
  sections: BriefingSection[];
  created_at: string;
}
