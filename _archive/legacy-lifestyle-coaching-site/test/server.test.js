const test = require('node:test');
const assert = require('node:assert/strict');
const { server, getStage, leadIsReady, canShowCheckout, stages } = require('../server');

test('server-owned stages require every lead field in order', () => {
  const lead = {};
  assert.equal(getStage(lead), stages.DISCOVERY);
  lead.primary_area = 'stress';
  assert.equal(getStage(lead), stages.OUTCOME);
  lead.desired_outcome = 'a calmer routine';
  assert.equal(getStage(lead), stages.NAME);
  lead.name = 'Sam';
  assert.equal(getStage(lead), stages.CONTACT_METHOD);
  lead.preferred_contact = 'email';
  assert.equal(getStage(lead), stages.CONTACT_DETAILS);
  lead.email = 'sam@example.com';
  assert.equal(getStage(lead), stages.AVAILABILITY);
  lead.availability = 'weekday evenings';
  assert.equal(getStage(lead), stages.CONSENT);
  assert.equal(leadIsReady(lead), false);
  lead.consent_to_contact = true;
  assert.equal(getStage(lead), stages.CHECKOUT);
  assert.equal(leadIsReady(lead), true);
});

test('a model checkout request cannot bypass missing fields or consent', () => {
  const incomplete = { primary_area: 'stress', consent_to_contact: true };
  assert.equal(canShowCheckout(incomplete, true, 'https://example.com'), false);

  const completeWithoutConsent = {
    primary_area: 'stress',
    desired_outcome: 'calmer routine',
    name: 'Sam',
    preferred_contact: 'email',
    email: 'sam@example.com',
    availability: 'evenings',
    consent_to_contact: false
  };
  assert.equal(canShowCheckout(completeWithoutConsent, true, 'https://example.com'), false);
});

test('fallback builds rapport and withholds checkout until explicit consent', async t => {
  process.env.STRIPE_CHECKOUT_URL = 'https://example.com/checkout';
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/chat`;
  let conversationId;

  async function chat(message) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId, message })
    });
    const body = await response.json();
    conversationId = body.conversation_id;
    return body;
  }

  const turns = [
    ['I feel overwhelmed by work', stages.OUTCOME],
    ['I want a calmer routine', stages.NAME],
    ['Sam Taylor', stages.CONTACT_METHOD],
    ['Email', stages.CONTACT_DETAILS],
    ['sam@example.com', stages.AVAILABILITY],
    ['Weekday evenings', stages.CONSENT]
  ];

  for (const [message, expectedStage] of turns) {
    const response = await chat(message);
    assert.equal(response.stage, expectedStage);
    assert.equal(response.show_checkout, false);
    assert.equal(response.lead_ready, false);
  }

  const declined = await chat('No, not right now');
  assert.equal(declined.stage, stages.CONSENT);
  assert.equal(declined.show_checkout, false);

  const consented = await chat('Yes, I consent');
  assert.equal(consented.stage, stages.CHECKOUT);
  assert.equal(consented.lead_ready, true);
  assert.equal(consented.show_checkout, true);
});
