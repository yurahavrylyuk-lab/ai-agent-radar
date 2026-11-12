import type { DiscoveryTopic } from "./discoveryPriority.js";
import type { FeedbackRating } from "./emailFeedback.js";

export interface FeedbackPreferenceObservation { discoveryKey:string; topics:readonly DiscoveryTopic[]; rating:FeedbackRating; logicalDate:string; deliveryKey:string; slot:number }
export type FeedbackPreferenceProfile=Readonly<Record<DiscoveryTopic,number>>;
const topics:DiscoveryTopic[]=["ai_ml","it_infrastructure","programming","developer_tools_workflow"];
export const neutralFeedbackProfile=():FeedbackPreferenceProfile=>({ai_ml:0,it_infrastructure:0,programming:0,developer_tools_workflow:0});

export function calculateFeedbackPreferenceProfile(values:readonly FeedbackPreferenceObservation[]):FeedbackPreferenceProfile {
  const profile={...neutralFeedbackProfile()};
  for(const topic of topics){ const relevant=new Set<string>(),negative=new Set<string>();
    for(const value of values) if(value.topics.includes(topic))(value.rating==="relevant"?relevant:negative).add(value.discoveryKey);
    const p=relevant.size,n=negative.size,total=p+n;
    profile[topic]=total>=5&&Math.abs(p-n)>=3?Math.max(-.5,Math.min(.5,.5*(p-n)/total)):0;
  } return profile;
}
export function feedbackPreferenceAdjustment(value:FeedbackPreferenceProfile,storyTopics:readonly DiscoveryTopic[]):number {
  return storyTopics.length?storyTopics.reduce((sum,t)=>sum+(value[t]??0),0)/storyTopics.length:0;
}
