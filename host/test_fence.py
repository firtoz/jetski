import pathlib
import tempfile
import unittest
import uuid
from fence import Fence

class FenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name) / 'control'
        self.fence = Fence(self.root)
        self.lease = dict(owner='alice', poolId='pool', slotId=str(uuid.uuid4()),
                          machineId='machine', sandboxId=str(uuid.uuid4()),
                          assignmentId=str(uuid.uuid4()), generation=1)
        self.receipt = dict(checkpointId=str(uuid.uuid4()), sha256='a'*64)

    def test_close_before_claim_survives_restart(self):
        self.fence.close(self.lease)
        with self.assertRaisesRegex(ValueError, 'closed_lease'):
            Fence(self.root).claim(self.lease)

    def test_cleanup_and_publication_gate_release(self):
        self.fence.claim(self.lease)
        self.fence.close(self.lease)
        with self.assertRaisesRegex(ValueError, 'unconfirmed'):
            self.fence.release(self.lease, lambda *_: False, self.receipt)
        self.assertEqual(self.fence.read()['phase'], 'closed')
        self.fence.release(self.lease, lambda *_: True, self.receipt)
        next_lease = dict(self.lease, generation=2, assignmentId=str(uuid.uuid4()))
        Fence(self.root).claim(next_lease)
        with self.assertRaisesRegex(ValueError, 'stale_lease'):
            self.fence.close(self.lease)

    def test_cross_owner_and_generation_gaps_rejected(self):
        self.fence.claim(self.lease)
        self.fence.close(self.lease)
        self.fence.release(self.lease, lambda *_: True, self.receipt)
        with self.assertRaisesRegex(ValueError, 'physical_identity_conflict'):
            self.fence.claim(dict(self.lease, owner='bob', generation=2))
        with self.assertRaisesRegex(ValueError, 'generation_gap'):
            self.fence.claim(dict(self.lease, generation=3))

    def test_symlink_state_rejected(self):
        target = pathlib.Path(self.temp.name) / 'outside'
        target.write_text('{}')
        (self.root / 'state.json').symlink_to(target)
        with self.assertRaises(OSError):
            self.fence.claim(self.lease)

if __name__ == '__main__':
    unittest.main()
