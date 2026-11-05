-- Cold moves are deferred. Keep completed transfer rows readable for audit.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM runtime.volume_transfers WHERE kind IN ('machine','snapshot') AND phase NOT IN ('done','cancelled','failed')) THEN
  RAISE EXCEPTION 'Finish or cancel outstanding cold transfers before upgrading';
 END IF;
 IF EXISTS (SELECT 1 FROM runtime.move_reservations r JOIN runtime.operations o ON o.id=r.operation_id WHERE o.state IN ('pending','running')) THEN
  RAISE EXCEPTION 'Finish outstanding cold move operations before upgrading';
 END IF;
END $$;
DROP TABLE runtime.move_reservations;
