// The secret words. Each round, every partnership shares one word (and a player with no partner gets a word
// nobody else has). Keep them single, common, easy-to-draw things. Add as many as you like.
export const WORDS: string[] = `
apple banana cherry grape lemon orange pear pineapple strawberry watermelon carrot potato tomato onion corn
pizza burger taco sandwich cookie cake donut icecream popcorn pancake cheese bread egg bacon pretzel sushi
dog cat horse cow pig sheep chicken duck rabbit mouse lion tiger bear elephant giraffe monkey zebra
dolphin whale shark octopus crab turtle frog snake spider butterfly bee ant owl penguin parrot eagle
tree flower mountain river ocean island desert volcano rainbow cloud moon star sun snowman lightning tornado
house castle bridge tent lighthouse windmill school hospital barn igloo skyscraper
car bus train airplane boat bicycle rocket helicopter submarine truck tractor scooter skateboard sled
chair table bed lamp clock mirror door window couch bathtub fireplace ladder umbrella
hat shoe sock shirt glove scarf crown glasses watch backpack necklace ring
phone computer camera television guitar piano drum trumpet violin microphone headphones
book pencil scissors key lock hammer saw broom bucket candle balloon flag anchor compass map
ball kite trophy medal dice puzzle robot teddy ghost dragon pirate wizard mermaid unicorn vampire
cactus mushroom pumpkin acorn leaf feather shell snowflake
bone brain heart tooth eye ear nose hand foot
spoon fork knife plate cup bottle teapot toaster blender
swing slide bell drumstick ticket envelope diamond magnet battery lightbulb
`
  .split(/\s+/)
  .filter(Boolean);
